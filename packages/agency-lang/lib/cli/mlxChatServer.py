"""mlx_lm.server, plus structured output, reply limits, and cancellation.

Started by `agency local serve <model>`. It is `mlx_lm.server` with three
additions.

A request whose `response_format` names a JSON schema gets a reply that fits
the schema, because the schema is enforced while the reply is generated.
`mlx_lm.server` on its own never reads `response_format`, so a typed `llm()`
call on an MLX model came back as prose.

A reply that has stopped making progress is cut short. Three limits watch
every reply as it is written. A thinking model may spend at most a budget of
tokens thinking, after which it has to close its thinking and answer. A reply
that keeps second-guessing itself ("But wait", "Hmm", "Let me reconsider")
past a count, or repeats a whole sentence a few times, is cut short too. The
last two watch the thinking by default and the answer only when asked,
because an answer repeats itself for honest reasons (a refrain, a table, the
same line of code three times) and thinking rarely does. Without these, a
small model that talks itself in circles runs to `max_tokens`, which on a
large model is minutes of the machine for nothing.

A reply whose client has gone is stopped, where `mlx_lm.server` would finish
it for nobody.

How the reply is constrained. A model writes one token at a time, scoring
every token it knows at each step. The grammar library llguidance knows the
schema and how much of the JSON has been written, and hands back a bitmask of
the tokens that could come next. `Watcher` below is a logits processor: at
each step it sets the score of every token outside that mask to minus
infinity, so the sampler cannot pick it. Once the JSON is complete, only the
end-of-reply token is left.

A thinking model is left alone while it thinks. A reply goes through up to
three phases:

  start      the model may open a `<think>` block, or start the answer
  reasoning  anything goes, except ending the reply, until `</think>`
  answer     every token must fit the schema, when there is one

When the chat template already opened a `<think>` block at the end of the
prompt, the reply starts in the reasoning phase. mlx_lm works that out for
its own purposes in `_tokenize`, and this script reads its answer. Once the
model closes the block, the answer starts.

How a limit cuts a reply short depends on the phase. While thinking, the
only tokens allowed are the ones that close the thinking block, so the model
has to answer. In an answer with a schema, the only tokens allowed for one
step are the ones that close the JSON string being written, so the field
ends and the schema carries the reply to its end. In a plain answer, only
the end-of-reply token is allowed. An answer cut short is reported with
`finish_reason: "length"`, the way a reply that hit `max_tokens` is, so the
caller can tell it from a complete one.

Each limit can be set per request, in the body: `reasoning_budget`,
`hedge_limit`, and `repeat_limit`, each a count with 0 meaning no limit, and
`limit_answers`, true to watch the answer as well as the thinking. A request
that names none gets the server's flags, `--reasoning-budget`,
`--hedge-limit`, `--repeat-limit`, and `--limit-answers`. The reasoning
budget defaults to half the request's `max_tokens`, and is always held far
enough under `max_tokens` to leave room for the answer.

How cancellation works. A client that gives up on a reply (Agency's per-call
timeout, or Ctrl-C in the run) closes its socket. `mlx_lm.server` only
touches that socket once the whole reply is generated, so it never notices;
the reply runs on to `max_tokens`, holding its share of the GPU and its
cache, and every other request in the batch runs slower for it. The handler
thread that waits for tokens here looks at its socket every half second
instead, and when the socket has been closed it tells the generator to drop
the reply. mlx_lm drops it at the next point it looks: on the batched path
that is after the next chunk of prompt or the next token, so within a
moment; on the single path, which a draft model or a seed puts a request
on, only once the whole prompt has been read, so a long prompt is still read
to the end. The batch frees the reply's cache on its next step.

With a draft model (`--draft-model`), mlx_lm generates speculatively: the
draft guesses several tokens, the main model checks them in one pass, and
the guesses it rejects are taken back. The logits processor is called for
the guesses too, and then sees the history shrink. `Watcher` keeps what it
learned from each token, so it can take back exactly the tokens that were
rejected, including what it told the grammar.

A request that carries tools keeps its `response_format` but the schema is
not enforced, because a tool call is not JSON and the constraint would break
it. That matches what the llama.cpp backend does. The limits still apply.

This script reaches into `mlx_lm.server`: it subclasses its request handler
and response generator, and replaces two module-level names, `run` and
`_make_logits_processors`. `agency local serve` pins the mlx-lm version for
that reason; a new version needs these seams checked.

Options are `mlx_lm.server`'s own (--model, --host, --port, --max-tokens, and
the rest) plus the limit flags above. Distributed serving (`mlx.distributed`)
is not supported; the script always runs the HTTP server in its own process.
"""

import argparse
import json
import logging
import re
import select
import socket
import sys
import time
from collections import Counter
from dataclasses import dataclass, replace
from queue import Empty as QueueEmpty
from queue import Queue

import numpy as np
from llguidance import LLMatcher
from llguidance.hf import from_tokenizer
from llguidance.mlx import apply_token_bitmask
from llguidance.numpy import allocate_token_bitmask, fill_next_token_bitmask
from mlx_lm import server
from mlx_lm.models.cache import can_trim_prompt_cache


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


# ---------------------------------------------------------------------------
# Token bitmasks: one bit per token, set when the token may come next.
# ---------------------------------------------------------------------------


def bit_index(token_id):
    return token_id // 32, np.uint32(1) << np.uint32(token_id % 32)


def allow(mask, token_id):
    word, bit = bit_index(token_id)
    mask.view(np.uint32)[0, word] |= bit


def forbid(mask, token_id):
    word, bit = bit_index(token_id)
    mask.view(np.uint32)[0, word] &= ~bit


def only(mask, token_ids):
    """Leave nothing allowed but `token_ids`."""
    mask.fill(0)
    for token_id in token_ids:
        allow(mask, token_id)


def intersect(mask, other):
    """Keep only the tokens both masks allow, in `mask`."""
    np.bitwise_and(mask, other, out=mask)


def allows_nothing(mask):
    return not mask.any()


# ---------------------------------------------------------------------------
# The limits, and how a reply is judged against them.
# ---------------------------------------------------------------------------


@dataclass
class Limits:
    """How far a reply may go before it is cut short. Each count's 0 means
    no limit. A reasoning budget of None means half the request's
    `max_tokens`, decided per request. `limit_answers` watches the answer
    for hedging and repeats too; by default only the thinking is watched."""

    reasoning_budget: int | None
    hedge_limit: int
    repeat_limit: int
    limit_answers: bool


# The server's flags. Replaced in __main__ from the command line.
SERVER_LIMITS = Limits(reasoning_budget=None, hedge_limit=12, repeat_limit=3, limit_answers=False)

# A reply is judged every this many tokens, not every token: the scans below
# read the text so far.
CHECK_EVERY = 16

# How much of the reply the hedge and repeat scans look at: the newest this
# many tokens. A loop says the same thing every few lines; an honest long
# reply says "wait" a dozen times over thousands of tokens. Counting over a
# window tells the two apart where a count over the whole reply cannot.
WINDOW = 2048

# The phrases a model uses when it doubts what it just wrote. "Wait" only
# counts with punctuation after it, so "wait until the lock is released"
# does not.
HEDGES = re.compile(
    r"\b(?:But wait|Wait)(?=[,.!?:;—–-])"
    r"|\bHmm+\b|\bHold on\b|\bActually,? wait\b"
    r"|\bLet me (?:reconsider|re-?check|double-?check|re-?examine|re-?read|verify|think again)\b"
)

SENTENCE_END = re.compile(r"(?<=[.!?])\s+|\n+")

# A sentence shorter than this is not counted as a repeat. "Yes." and "So
# the answer is 51." recur in honest working.
MIN_SENTENCE_WORDS = 6

# A token that ends the JSON string being written: a double quote first,
# after any spaces (which are part of the string).
STRING_CLOSER = re.compile(r'^\s*"')


@dataclass
class TokenMasks:
    """Two facts about every token of one model, as bitmasks: whether it
    can end a JSON string, and whether it is anything but whitespace."""

    closers: np.ndarray
    non_space: np.ndarray


def token_masks(hf_tokenizer, vocab_width):
    """Decodes the whole vocabulary once, which takes a moment."""
    closers = allocate_token_bitmask(1, vocab_width)
    closers.fill(0)
    non_space = allocate_token_bitmask(1, vocab_width)
    non_space.fill(0)
    texts = hf_tokenizer.batch_decode([[i] for i in range(len(hf_tokenizer))])
    for token_id, text in enumerate(texts):
        if STRING_CLOSER.match(text):
            allow(closers, token_id)
        if text.strip() != "":
            allow(non_space, token_id)
    return TokenMasks(closers=closers, non_space=non_space)


def count_hedges(text):
    return len(HEDGES.findall(text))


def most_repeated_sentence(text):
    """How many times the most repeated long sentence appears in `text`."""
    sentences = [" ".join(s.split()) for s in SENTENCE_END.split(text)]
    long_ones = [s for s in sentences if len(s.split()) >= MIN_SENTENCE_WORDS]
    if not long_ones:
        return 0
    return max(Counter(long_ones).values())


def answer_reserve(max_tokens):
    """Tokens kept free for the answer after the thinking: an eighth of the
    reply, and never fewer than 256."""
    return max(256, max_tokens // 8)


def limits_for(body, max_tokens, defaults):
    """The limits for one request: the fields it names, else the server's
    flags. The reasoning budget is held under `max_tokens` by the answer's
    reserve, whoever set it. Raises ValueError for a field of the wrong
    shape, which the handler turns into a 400."""

    def count(name, default):
        value = body.get(name)
        if value is None:
            return default
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"{name} must be a whole number, 0 or more.")
        return value

    limit_answers = body.get("limit_answers", defaults.limit_answers)
    if not isinstance(limit_answers, bool):
        raise ValueError("limit_answers must be true or false.")

    budget = count("reasoning_budget", defaults.reasoning_budget)
    if budget is None:
        budget = max_tokens // 2
    most = max(0, max_tokens - answer_reserve(max_tokens))
    if budget > most:
        logging.info(
            f"A reasoning budget of {budget} leaves no room to answer in {max_tokens} tokens; using {most}."
        )
        budget = most
    return Limits(
        reasoning_budget=budget,
        hedge_limit=count("hedge_limit", defaults.hedge_limit),
        repeat_limit=count("repeat_limit", defaults.repeat_limit),
        limit_answers=limit_answers,
    )


@dataclass
class WatcherState:
    """Everything about a reply that one more token can change. A snapshot
    is kept per token, so that a token taken back by speculative decoding
    takes its effects back with it."""

    phase: str
    reasoning_tokens: int
    # While the thinking is being closed, the index of the next token of
    # the closing sequence. None otherwise.
    closing: int | None
    # The token the judged text starts at. The answer is judged on its own,
    # not with the thinking before it, and a JSON field cut short does not
    # count against the fields after it.
    judged_from: int
    # A plain answer being cut short: only end-of-reply tokens may come.
    ending: bool
    # A JSON answer being cut short: for one step, only tokens that close
    # the string being written may come.
    closing_string: bool
    # After that, no whitespace-only tokens: JSON allows any amount of
    # whitespace between its parts, and a model whose string was closed
    # under it will pad with tabs to max_tokens if it is let.
    compact: bool
    # How many tokens the grammar has been fed, for taking them back.
    consumed: int
    # The grammar rejected a token; the rest of the reply runs unconstrained.
    broken: bool
    # Why the answer was cut short, or None. Reported as finish_reason
    # "length". Closing the thinking is not a cut: the answer still comes.
    cut: str | None


class Watcher:
    """The logits processor for one reply. mlx_lm calls it with the token
    history so far and the scores for the next token, and takes back the
    scores it should sample from. It enforces the schema, when there is one,
    and the limits.

    The history it sees starts partway through the prompt, since mlx_lm
    processes most of the prompt without calling any processor, and grows
    by one token per step. The first call fixes where the reply begins;
    every later call feeds the tokens since then into the phase machine.
    Under speculative decoding the history can also shrink, when the main
    model rejects the draft's guesses; see `rewind`."""

    def __init__(
        self,
        tokenizer,
        ll_tokenizer_for,
        token_masks_for,
        piece_for,
        grammar,
        initial_state,
        limits,
        vocab_width,
    ):
        self.tokenizer = tokenizer
        self.ll_tokenizer_for = ll_tokenizer_for
        self.token_masks_for = token_masks_for
        self.piece_for = piece_for
        self.grammar = grammar
        self.limits = limits
        # The main model's output width. A draft model's logits may be
        # narrower, and the masks have to cover the main model's tokens.
        self.vocab_width = vocab_width
        if not tokenizer.has_thinking:
            phase = "answer"
        elif initial_state == "reasoning":
            phase = "reasoning"
        else:
            phase = "start"
        self.think_start = tokenizer.think_start_tokens
        self.think_end = tokenizer.think_end_tokens
        self.state = WatcherState(
            phase=phase,
            reasoning_tokens=0,
            closing=None,
            judged_from=0,
            ending=False,
            closing_string=False,
            compact=False,
            consumed=0,
            broken=False,
            cut=None,
        )
        self.initial = replace(self.state)
        self.seen = None
        # Where the reply starts in the history mlx_lm hands over.
        self.start = None
        # Per token of the reply: its id, its text, and the state after it.
        self.reply = []
        self.pieces = []
        self.states = []
        self.matcher = None
        self.mask = None
        self.free_mask = None
        self.end_mask = None
        self.token_masks = None

    @property
    def cut(self):
        return self.state.cut

    def prepare(self, vocab_width):
        """Built on the first call, because only the logits say how wide the
        model's output is. A padded output layer is wider than the tokenizer's
        vocabulary, and the mask has to cover the whole row."""
        self.mask = allocate_token_bitmask(1, vocab_width)
        # While thinking, everything is allowed but ending the reply. The
        # model has to close the block and write the answer.
        self.free_mask = allocate_token_bitmask(1, vocab_width)
        for token_id in self.tokenizer.eos_token_ids:
            forbid(self.free_mask, token_id)
        self.end_mask = allocate_token_bitmask(1, vocab_width)
        only(self.end_mask, self.tokenizer.eos_token_ids)
        if self.grammar is not None:
            ll_tokenizer = self.ll_tokenizer_for(vocab_width)
            self.matcher = LLMatcher(ll_tokenizer, self.grammar)
            if self.matcher.is_error():
                raise ValueError(self.matcher.get_error())
            self.token_masks = self.token_masks_for(vocab_width)

    def consume(self, token_id):
        """Feed one JSON token to the matcher. A token it rejects, which can
        only happen when llguidance and mlx_lm disagree about the tokenizer,
        leaves it in an error state for good; from then on the reply runs
        unconstrained, and the log says why, so the caller gets a reply that
        fails validation rather than one built from a broken matcher."""
        if self.matcher is None or self.state.broken:
            return
        if self.matcher.consume_token(token_id):
            self.state.consumed += 1
            return
        self.state.broken = True
        logging.error(
            f"The schema constraint failed and the rest of this reply is "
            f"unconstrained: {self.matcher.get_error()}"
        )

    def enter_answer(self):
        self.state.phase = "answer"
        self.state.closing = None
        self.state.judged_from = len(self.pieces)

    def step(self, token_id):
        """One generated token moves the phase machine. The answer is judged
        from its first token, so a reply that starts with the answer enters
        the phase before the token is added to the text, and one that closes
        its thinking enters it after, so the closing tokens are left out."""
        state = self.state
        self.reply.append(token_id)
        if state.phase == "start":
            if token_id == self.think_start[0]:
                state.phase = "reasoning"
            else:
                self.enter_answer()
            self.pieces.append(self.piece_for(token_id))
            if state.phase == "answer":
                self.consume(token_id)
        elif state.phase == "reasoning":
            self.pieces.append(self.piece_for(token_id))
            state.reasoning_tokens += 1
            if state.closing is not None and token_id == self.think_end[state.closing]:
                state.closing += 1
            tail = tuple(self.reply[-len(self.think_end) :])
            if tail == self.think_end:
                self.enter_answer()
        else:
            self.pieces.append(self.piece_for(token_id))
            self.consume(token_id)
        if len(self.reply) % CHECK_EVERY == 0:
            self.check()
        self.states.append(replace(state))

    def rewind(self, count):
        """Take back the last `count` tokens: the draft's guesses the main
        model rejected. Everything they changed is restored from the
        snapshot before them, and the grammar takes back what it was fed."""
        fed = self.state.consumed
        del self.reply[-count:]
        del self.pieces[-count:]
        del self.states[-count:]
        self.state = replace(self.states[-1]) if self.states else replace(self.initial)
        if self.matcher is not None and fed > self.state.consumed:
            self.matcher.rollback(fed - self.state.consumed)

    def resync(self, tokens):
        """mlx_lm 0.31.3 only ever shortens the history to a prefix of itself
        and appends to it, so taking back tokens by count keeps the reply in
        step with it. This guards the day that changes: when the last token
        of the history is not the last token stepped, find where the two
        part, take back from there, and step the rest. One element per call
        when they agree."""
        if not self.reply or int(tokens[-1].item()) == self.reply[-1]:
            return
        history = tokens[self.start :].tolist()
        shared = min(len(history), len(self.reply))
        parted = next((i for i in range(shared) if history[i] != self.reply[i]), shared)
        logging.warning(
            f"The token history parted from the reply at token {parted}; reading it again from there."
        )
        self.rewind(len(self.reply) - parted)
        for token_id in history[parted:]:
            self.step(token_id)

    def judged_text(self):
        """The newest WINDOW tokens of the text being judged."""
        start = max(self.state.judged_from, len(self.pieces) - WINDOW)
        return "".join(self.pieces[start:])

    def check(self):
        """Has the reply gone past a limit? Called every CHECK_EVERY tokens."""
        state = self.state
        if state.phase == "reasoning":
            if state.closing is not None:
                return
            budget = self.limits.reasoning_budget
            if budget and state.reasoning_tokens >= budget:
                self.cut_short(f"has thought for {state.reasoning_tokens} tokens, its budget")
                return
        elif state.ending or not self.limits.limit_answers:
            return
        text = self.judged_text()
        if self.limits.hedge_limit:
            hedges = count_hedges(text)
            if hedges >= self.limits.hedge_limit:
                self.cut_short(f"has second-guessed itself {hedges} times")
                return
        if self.limits.repeat_limit:
            repeats = most_repeated_sentence(text)
            if repeats >= self.limits.repeat_limit:
                self.cut_short(f"has repeated a sentence {repeats} times")

    def cut_short(self, why):
        state = self.state
        if state.phase == "reasoning":
            logging.info(f"The reply {why}; closing its thinking.")
            state.closing = 0
        elif self.matcher is not None:
            logging.info(f"The reply {why}; closing the JSON string it is writing.")
            state.closing_string = True
            state.compact = True
            state.judged_from = len(self.pieces)
            state.cut = why
        else:
            logging.info(f"The reply {why}; ending it.")
            state.ending = True
            state.cut = why

    def __call__(self, tokens, logits):
        count = tokens.shape[-1]
        if self.seen is None:
            self.prepare(max(logits.shape[-1], self.vocab_width))
            self.seen = count
            self.start = count
        else:
            if count < self.seen:
                self.rewind(self.seen - count)
            for token_id in tokens[self.seen :].tolist():
                self.step(token_id)
            self.seen = count
            self.resync(tokens)
        state = self.state
        if state.phase == "reasoning":
            if state.closing is not None:
                only(self.mask, [self.think_end[state.closing]])
                return apply_token_bitmask(logits, self.mask)
            return apply_token_bitmask(logits, self.free_mask)
        if state.ending:
            return apply_token_bitmask(logits, self.end_mask)
        if self.matcher is None or state.broken:
            return logits
        fill_next_token_bitmask(self.matcher, self.mask)
        if state.phase == "start":
            allow(self.mask, self.think_start[0])
        if state.closing_string:
            # The tokens that both fit the schema and close the string. None
            # of them is allowed mid-escape; then the next step tries again.
            self.narrow(self.token_masks.closers, once=True)
        elif state.compact:
            self.narrow(self.token_masks.non_space)
        return apply_token_bitmask(logits, self.mask)

    def narrow(self, to, once=False):
        """Keep only the tokens of `self.mask` that `to` allows as well, when
        that leaves any. With `once`, a narrowing that took ends the closing
        of the string."""
        narrowed = self.mask.copy()
        intersect(narrowed, to)
        if allows_nothing(narrowed):
            return
        np.copyto(self.mask, narrowed)
        if once:
            self.state.closing_string = False


# ---------------------------------------------------------------------------
# Cancellation.
# ---------------------------------------------------------------------------

# How often a handler looks at its socket while it waits for tokens.
CLIENT_POLL_SECONDS = 0.5

# What the queue gave back when it gave back nothing in time.
WAITING = object()


def client_gone(connection):
    """Whether the client closed its end of the socket. A client sends
    nothing after its request, so the socket is only readable once the
    client has closed it, and a peek then returns no bytes. A socket that
    errors is gone too."""
    try:
        readable, _, _ = select.select([connection], [], [], 0)
    except ValueError:
        # A file descriptor select cannot watch. Not knowing is not gone.
        return False
    except OSError:
        return True
    if not readable:
        return False
    try:
        return connection.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True


# ---------------------------------------------------------------------------
# The seams into mlx_lm.server.
# ---------------------------------------------------------------------------


class Generator(server.ResponseGenerator):
    """The one place that sees the request, the tokenizer, and the prompt's
    thinking state together. It hangs the watcher on the request's
    arguments, where `make_logits_processors` picks it up. It also hands
    each handler a token stream that watches the handler's socket."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.ll_tokenizers = {}
        self.token_masks = {}
        self.pieces = {}

    def ll_tokenizer_for(self, tokenizer, vocab_width):
        # Wrapping a tokenizer takes about a second, so each is kept, keyed
        # on the model it belongs to.
        key = (self.model_provider.model_key, vocab_width)
        if key not in self.ll_tokenizers:
            self.ll_tokenizers[key] = from_tokenizer(
                tokenizer._tokenizer,
                n_vocab=vocab_width,
                eos_token=list(tokenizer.eos_token_ids),
            )
        return self.ll_tokenizers[key]

    def token_masks_for(self, tokenizer, vocab_width):
        # Kept for the same reason, keyed the same way.
        key = (self.model_provider.model_key, vocab_width)
        if key not in self.token_masks:
            self.token_masks[key] = token_masks(tokenizer._tokenizer, vocab_width)
        return self.token_masks[key]

    def piece_for(self, tokenizer, token_id):
        """The text of one token on its own. Rough at the edges of a
        multi-byte character, which is fine for scanning a reply for
        phrases and sentences, and cheap enough to keep per token."""
        key = (self.model_provider.model_key, token_id)
        piece = self.pieces.get(key)
        if piece is None:
            piece = tokenizer.decode([token_id])
            self.pieces[key] = piece
        return piece

    def vocab_width(self):
        """The main model's output width, from its config."""
        args = getattr(self.model_provider.model, "args", None)
        return getattr(args, "vocab_size", 0) or 0

    def _tokenize(self, tokenizer, request, args):
        result = super()._tokenize(tokenizer, request, args)
        initial_state = result[3]
        grammar = getattr(request, "grammar", None)
        limits = getattr(request, "limits", None)
        if limits is None:
            limits = limits_for({}, args.max_tokens, SERVER_LIMITS)
        if grammar is not None:
            logging.info(f"Constraining the reply to a schema, from state {initial_state!r}")
        args.watcher = Watcher(
            tokenizer,
            lambda width: self.ll_tokenizer_for(tokenizer, width),
            lambda width: self.token_masks_for(tokenizer, width),
            lambda token_id: self.piece_for(tokenizer, token_id),
            grammar,
            initial_state,
            limits,
            self.vocab_width(),
        )
        return result

    def _serve_single(self, request):
        """mlx_lm's path for a request it cannot batch: every request when a
        draft model is loaded, and any request with a seed. mlx_lm holds the
        prompt cache to `--prompt-cache-bytes` only on the batched path, so
        this one trims it the same way: before the reply, so the cache is
        under the cap while the reply runs, and after, for what the reply
        added."""
        limit = self.model_provider.cli_args.prompt_cache_bytes
        if limit is not None:
            self.prompt_cache.trim_to(n_bytes=limit)
        super()._serve_single(request)
        if limit is not None:
            self.prompt_cache.trim_to(n_bytes=limit)

    def check_generating(self):
        """Every reply comes from the one generation thread. If it has died,
        from an error it did not catch such as the GPU running out of memory,
        every request would wait for ever. Fail the request instead, so the
        caller sees an error and the server can be restarted."""
        if not self._generation_thread.is_alive():
            raise RuntimeError("The server's generation thread has stopped; restart the server.")

    def generate(self, request, args, progress_callback=None):
        """mlx_lm's `generate`, with two changes. While the handler waits for
        the next token it looks at its socket every half second, and stops
        the reply when the client has closed it. mlx_lm's version blocks on
        the queue until the reply is complete, so it can only find out the
        client is gone when it writes the finished reply. And a reply the
        watcher cut short ends with finish_reason "length", not "stop".

        The generation thread stops a reply by dropping it from the batch
        on its next step, once `ctx.stop()` has been called; the tokens it
        already queued are left unread."""
        connection = getattr(request, "connection", None)
        response_queue = Queue()
        self.requests.put((response_queue, request, args))

        while True:
            try:
                ctx = response_queue.get(timeout=CLIENT_POLL_SECONDS)
                break
            except QueueEmpty:
                self.check_generating()
        if isinstance(ctx, Exception):
            raise ctx

        def tokens():
            # The socket is looked at on a clock, not only when the queue
            # runs dry: a reply that streams a token every few milliseconds
            # never leaves the queue empty for long.
            last_look = time.monotonic()
            while True:
                try:
                    response = response_queue.get(timeout=CLIENT_POLL_SECONDS)
                except QueueEmpty:
                    response = WAITING
                    self.check_generating()
                if connection is not None and time.monotonic() - last_look >= CLIENT_POLL_SECONDS:
                    last_look = time.monotonic()
                    if client_gone(connection):
                        logging.info("The client went away; stopping its reply.")
                        ctx.stop()
                        return
                if response is WAITING:
                    continue
                if response is None:
                    return
                if isinstance(response, Exception):
                    raise response
                if isinstance(response, tuple):
                    if progress_callback is not None:
                        progress_callback(*response)
                    continue
                watcher = getattr(args, "watcher", None)
                if response.finish_reason is not None and watcher is not None and watcher.cut:
                    response = replace(response, finish_reason="length")
                yield response

        return ctx, server._process_control_tokens(ctx, tokens())


original_make_logits_processors = server._make_logits_processors


def keep_logits(tokens, logits):
    return logits


def make_logits_processors(args):
    """The request's own processors, plus its watcher. A request with
    nothing to apply still gets one processor that changes nothing: mlx_lm
    0.31.3's batch generator trims its list of processors only when some
    entry is truthy, so a request with an empty list would leave a stale
    entry behind when it finished, and the next request's watcher would
    sit at the wrong index and never run. Fixed upstream in mlx-lm PR
    #1772, after 0.31.3; drop this once the pin moves past it."""
    processors = list(original_make_logits_processors(args))
    watcher = getattr(args, "watcher", None)
    if watcher is not None:
        processors.append(watcher)
    if not processors:
        processors.append(keep_logits)
    return processors


class Handler(server.APIHandler):
    def handle_chat_completions(self):
        request = super().handle_chat_completions()
        request.grammar = None
        # The socket the reply goes to, so `Generator.generate` can tell
        # when the client has closed it.
        request.connection = self.connection
        try:
            request.limits = limits_for(self.body, self.max_tokens, SERVER_LIMITS)
            if request.tools:
                if self.body.get("response_format") is not None:
                    logging.warning("response_format is not enforced on a request with tools.")
            else:
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
        except (BrokenPipeError, ConnectionResetError):
            # A stopped reply is still written out, to a socket the client
            # has closed. Without this, the server prints a traceback for it.
            logging.info("The client went away before its reply was written.")


class RequestRefused(Exception):
    """The handler already wrote a 400; nothing else should be written."""


def untrimmable_cache(cache):
    """Why speculative decoding cannot run on a model with this attention
    cache, or None when it can. The main model checks a whole draft in one
    pass and has to take back the guesses it rejects, so every layer's cache
    must be able to give tokens back. The standard attention cache can;
    the recurrent and hybrid ones (Qwen3.5, Qwen3-Next, Mamba) cannot."""
    if can_trim_prompt_cache(cache):
        return None
    kinds = ", ".join(sorted({type(c).__name__ for c in cache}))
    return f"its attention cache ({kinds}) cannot give tokens back"


def refuse_draft_if_unusable(model_provider):
    """mlx_lm only finds out that a model cannot draft when the first
    request fails, after the server has answered its readiness check. This
    finds out before the server opens, so `agency local serve --draft` fails
    with the reason instead of failing every request."""
    if model_provider.cli_args.draft_model is None:
        return
    model_provider.load_default()
    if model_provider.draft_model is None:
        return
    problem = untrimmable_cache(server.make_prompt_cache(model_provider.model))
    if problem is None:
        return
    logging.error(
        f"{model_provider.cli_args.model} cannot use a draft model: {problem}. "
        f"Serve it without --draft."
    )
    sys.exit(2)


def run(host, port, model_provider):
    refuse_draft_if_unusable(model_provider)
    prompt_cache = server.LRUPromptCache(model_provider.cli_args.prompt_cache_size)
    generator = Generator(model_provider, prompt_cache)
    server._run_http_server(host, port, generator, handler_class=Handler)


def split_own_flags(argv):
    """The limit flags, which are this script's own, and the rest of the
    command line, which is mlx_lm.server's."""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--reasoning-budget", type=int, default=SERVER_LIMITS.reasoning_budget)
    parser.add_argument("--hedge-limit", type=int, default=SERVER_LIMITS.hedge_limit)
    parser.add_argument("--repeat-limit", type=int, default=SERVER_LIMITS.repeat_limit)
    parser.add_argument("--limit-answers", action="store_true", default=SERVER_LIMITS.limit_answers)
    own, rest = parser.parse_known_args(argv)
    limits = Limits(
        reasoning_budget=own.reasoning_budget,
        hedge_limit=own.hedge_limit,
        repeat_limit=own.repeat_limit,
        limit_answers=own.limit_answers,
    )
    return limits, rest


if __name__ == "__main__":
    SERVER_LIMITS, rest = split_own_flags(sys.argv[1:])
    sys.argv = [sys.argv[0]] + rest
    server.run = run
    server._make_logits_processors = make_logits_processors
    server.main()
