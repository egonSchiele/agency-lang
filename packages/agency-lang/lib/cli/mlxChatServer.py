"""mlx_lm.server, plus structured output.

Started by `agency local serve <model>`. It is `mlx_lm.server` with one
addition: a request whose `response_format` names a JSON schema gets a reply
that fits the schema, because the schema is enforced while the reply is
generated. `mlx_lm.server` on its own never reads `response_format`, so a
typed `llm()` call on an MLX model came back as prose.

How the reply is constrained. A model writes one token at a time, scoring
every token it knows at each step. The grammar library llguidance knows the
schema and how much of the JSON has been written, and hands back a bitmask of
the tokens that could come next. `Constraint` below is a logits processor: at
each step it sets the score of every token outside that mask to minus
infinity, so the sampler cannot pick it. Once the JSON is complete, only the
end-of-reply token is left.

A thinking model is left alone while it thinks. A reply goes through up to
three phases:

  start      the model may open a `<think>` block, or start the JSON
  reasoning  anything goes, except ending the reply, until `</think>`
  json       every token must fit the schema

When the chat template already opened a `<think>` block at the end of the
prompt, the reply starts in the reasoning phase. mlx_lm works that out for
its own purposes in `_tokenize`, and this script reads its answer. Once the
model closes the block, the JSON starts.

A request that carries tools keeps its `response_format` but the schema is
not enforced, because a tool call is not JSON and the constraint would break
it. That matches what the llama.cpp backend does.

This script reaches into `mlx_lm.server`: it subclasses its request handler
and response generator, and replaces two module-level names, `run` and
`_make_logits_processors`. `agency local serve` pins the mlx-lm version for
that reason; a new version needs these seams checked.

Options are `mlx_lm.server`'s own: --model, --host, --port, --max-tokens, and
the rest.
"""

import json
import logging

import numpy as np
from llguidance import LLMatcher
from llguidance.hf import from_tokenizer
from llguidance.mlx import apply_token_bitmask
from llguidance.numpy import allocate_token_bitmask, fill_next_token_bitmask
from mlx_lm import server


def grammar_for(response_format):
    """The llguidance grammar for a request's `response_format`, or None when
    it asks for none. Raises ValueError for a shape this script cannot
    honour, which the handler turns into a 400."""
    if response_format is None:
        return None
    if not isinstance(response_format, dict):
        raise ValueError("response_format must be an object.")
    kind = response_format.get("type")
    if kind in (None, "text"):
        return None
    if kind == "json_object":
        return LLMatcher.grammar_from_json_schema({"type": "object"})
    if kind == "json_schema":
        schema = response_format.get("json_schema")
        if not isinstance(schema, dict) or "schema" not in schema:
            raise ValueError("response_format.json_schema.schema is missing.")
        grammar = LLMatcher.grammar_from_json_schema(schema["schema"])
        problem = LLMatcher.validate_grammar(grammar)
        if problem and not LLMatcher.is_validate_warning(problem):
            raise ValueError(f"The schema cannot be enforced: {problem}")
        return grammar
    raise ValueError(f"response_format.type {kind!r} is not supported.")


def bit_index(token_id):
    return token_id // 32, np.uint32(1) << np.uint32(token_id % 32)


def allow(mask, token_id):
    word, bit = bit_index(token_id)
    mask.view(np.uint32)[0, word] |= bit


def forbid(mask, token_id):
    word, bit = bit_index(token_id)
    mask.view(np.uint32)[0, word] &= ~bit


class Constraint:
    """The logits processor for one reply. mlx_lm calls it with the token
    history so far and the scores for the next token, and takes back the
    scores it should sample from.

    The history it sees starts partway through the prompt, since mlx_lm
    processes most of the prompt without calling any processor, and grows by
    one token per step. The first call fixes where the reply begins; every
    later call feeds the tokens since then into the phase machine."""

    def __init__(self, tokenizer, ll_tokenizer_for, grammar, initial_state):
        self.tokenizer = tokenizer
        self.ll_tokenizer_for = ll_tokenizer_for
        self.grammar = grammar
        if not tokenizer.has_thinking:
            self.phase = "json"
        elif initial_state == "reasoning":
            self.phase = "reasoning"
        else:
            self.phase = "start"
        self.think_start = tokenizer.think_start_tokens
        self.think_end = tokenizer.think_end_tokens
        self.seen = None
        self.reply = []
        self.matcher = None
        self.mask = None
        self.free_mask = None

    def prepare(self, vocab_width):
        """Built on the first call, because only the logits say how wide the
        model's output is. A padded output layer is wider than the tokenizer's
        vocabulary, and the mask has to cover the whole row."""
        ll_tokenizer = self.ll_tokenizer_for(vocab_width)
        self.matcher = LLMatcher(ll_tokenizer, self.grammar)
        if self.matcher.is_error():
            raise ValueError(self.matcher.get_error())
        self.mask = allocate_token_bitmask(1, vocab_width)
        # While thinking, everything is allowed but ending the reply. The
        # model has to close the block and write the JSON.
        self.free_mask = allocate_token_bitmask(1, vocab_width)
        for token_id in self.tokenizer.eos_token_ids:
            forbid(self.free_mask, token_id)

    def step(self, token_id):
        """One generated token moves the phase machine."""
        self.reply.append(token_id)
        if self.phase == "start":
            if token_id == self.think_start[0]:
                self.phase = "reasoning"
            else:
                self.phase = "json"
                self.matcher.consume_token(token_id)
        elif self.phase == "reasoning":
            tail = tuple(self.reply[-len(self.think_end) :])
            if tail == self.think_end:
                self.phase = "json"
        else:
            self.matcher.consume_token(token_id)

    def __call__(self, tokens, logits):
        count = tokens.shape[-1]
        if self.seen is None:
            self.prepare(logits.shape[-1])
            self.seen = count
        else:
            for token_id in tokens[self.seen :].tolist():
                self.step(token_id)
            self.seen = count
        if self.phase == "reasoning":
            return apply_token_bitmask(logits, self.free_mask)
        fill_next_token_bitmask(self.matcher, self.mask)
        if self.phase == "start":
            allow(self.mask, self.think_start[0])
        return apply_token_bitmask(logits, self.mask)


class Generator(server.ResponseGenerator):
    """The one place that sees the request, the tokenizer, and the prompt's
    thinking state together. It hangs the constraint on the request's
    arguments, where `make_logits_processors` picks it up."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.ll_tokenizers = {}

    def ll_tokenizer_for(self, tokenizer, vocab_width):
        # Wrapping a tokenizer takes about a second, so each is kept.
        key = (id(tokenizer), vocab_width)
        if key not in self.ll_tokenizers:
            self.ll_tokenizers[key] = from_tokenizer(
                tokenizer._tokenizer,
                n_vocab=vocab_width,
                eos_token=list(tokenizer.eos_token_ids),
            )
        return self.ll_tokenizers[key]

    def _tokenize(self, tokenizer, request, args):
        result = super()._tokenize(tokenizer, request, args)
        initial_state = result[3]
        grammar = getattr(request, "grammar", None)
        args.constraint = None
        if grammar is not None:
            logging.info(f"Constraining the reply to a schema, from state {initial_state!r}")
            args.constraint = Constraint(
                tokenizer,
                lambda width: self.ll_tokenizer_for(tokenizer, width),
                grammar,
                initial_state,
            )
        return result


original_make_logits_processors = server._make_logits_processors


def keep_logits(tokens, logits):
    return logits


def make_logits_processors(args):
    """The request's own processors, plus its constraint. A request with
    nothing to apply still gets one processor that changes nothing: mlx_lm
    0.31.3's batch generator trims its list of processors only when some
    entry is truthy, so a request with an empty list would leave a stale
    entry behind when it finished, and the next request's constraint would
    sit at the wrong index and never run. Fixed upstream in mlx-lm PR
    #1772, after 0.31.3; drop this once the pin moves past it."""
    processors = list(original_make_logits_processors(args))
    constraint = getattr(args, "constraint", None)
    if constraint is not None:
        processors.append(constraint)
    if not processors:
        processors.append(keep_logits)
    return processors


class Handler(server.APIHandler):
    def handle_chat_completions(self):
        request = super().handle_chat_completions()
        request.grammar = None
        if request.tools:
            if self.body.get("response_format") is not None:
                logging.warning(
                    "response_format is not enforced on a request with tools."
                )
            return request
        try:
            request.grammar = grammar_for(self.body.get("response_format"))
        except ValueError as problem:
            self._set_completion_headers(400)
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(problem)}).encode())
            raise RequestRefused()
        return request

    def do_POST(self):
        try:
            super().do_POST()
        except RequestRefused:
            return


class RequestRefused(Exception):
    """The handler already wrote a 400; nothing else should be written."""


def run(host, port, model_provider):
    prompt_cache = server.LRUPromptCache(model_provider.cli_args.prompt_cache_size)
    generator = Generator(model_provider, prompt_cache)
    server._run_http_server(host, port, generator, handler_class=Handler)


if __name__ == "__main__":
    server.run = run
    server._make_logits_processors = make_logits_processors
    server.main()
