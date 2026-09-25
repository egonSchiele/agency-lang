"""Unit tests for the chat server's reply watcher and its pure helpers.

Run with the MLX environment's Python, from packages/agency-lang:

    ~/.agency-agent/mlx-env/bin/python -m unittest lib/cli/test_mlxChatServer.py

They need mlx_lm and llguidance installed, which that environment has, but
no model: the tokenizer and the grammar matcher are fakes, and the logits
are zeros. `apply_token_bitmask` is the real one, so a Metal device is used
for the masking.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

import mlx.core as mx
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import mlxChatServer as m  # noqa: E402

WIDTH = 64
THINK_START = 60
THINK_END = 61
EOS = 62
QUOTE = 40
SPACE = 41


class FakeTokenizer:
    """Tokens 0..39 are words; each decodes to " w<id>" so hedges can be
    spelled by choosing ids. A few ids carry fixed text."""

    has_thinking = True
    think_start_tokens = (THINK_START,)
    think_end_tokens = (THINK_END,)
    eos_token_ids = {EOS}
    texts = {
        1: " But wait,",
        2: " Hmm",
        3: " the cat sat on the mat today.",
        4: " Wait until the lock is released.",
        QUOTE: '"',
        SPACE: " ",
    }

    def decode(self, ids):
        return "".join(self.texts.get(i, f" w{i}") for i in ids)


class FakeMatcher:
    """Accepts every token but EOS, and remembers what it was fed."""

    def __init__(self):
        self.fed = []
        self.rolled_back = 0

    def is_error(self):
        return False

    def consume_token(self, token_id):
        if token_id == EOS:
            return False
        self.fed.append(token_id)
        return True

    def rollback(self, n):
        self.rolled_back += n
        del self.fed[-n:]

    def get_error(self):
        return "fake"


def allowed(masked):
    return set(np.where(np.array(masked[0]) > -1e30)[0].tolist())


class NoThinkingTokenizer(FakeTokenizer):
    """A model without thinking, such as Llama: mlx_lm gives None for its
    thinking markers."""

    has_thinking = False
    think_start_tokens = None
    think_end_tokens = None


def watcher(limits, grammar=None, initial="reasoning", matcher=None, tokenizer=None):
    tokenizer = tokenizer or FakeTokenizer()
    masks = m.TokenMasks(
        closers=m.allocate_token_bitmask(1, WIDTH),
        non_space=m.allocate_token_bitmask(1, WIDTH),
    )
    masks.closers.fill(0)
    m.allow(masks.closers, QUOTE)
    masks.non_space.fill(-1)
    m.forbid(masks.non_space, SPACE)
    w = m.Watcher(
        tokenizer,
        lambda width: object(),
        lambda width: masks,
        lambda t: tokenizer.decode([t]),
        grammar,
        initial,
        limits,
        WIDTH,
    )
    if grammar is not None:
        w.matcher_to_use = matcher or FakeMatcher()
    return w


def drive(w, ids, prompt=3):
    """Call the watcher the way mlx_lm does: once with the prompt's tail,
    then once per token with the whole history."""
    logits = mx.zeros((1, WIDTH))
    history = list(range(100, 100 + prompt))
    out = w(mx.array(history), logits)
    for t in ids:
        history.append(t)
        out = w(mx.array(history), logits)
    return out, history


def call(w, history):
    return w(mx.array(history), mx.zeros((1, WIDTH)))


def with_fake_matcher(test):
    """Make the watcher build a FakeMatcher and fill masks from it."""

    def fake_matcher(ll_tokenizer, grammar):
        return test.matcher

    def fill(matcher, mask):
        mask.fill(-1)
        m.forbid(mask, EOS)

    return mock.patch.multiple(m, LLMatcher=fake_matcher, fill_next_token_bitmask=fill)


NO_LIMITS = m.Limits(reasoning_budget=0, hedge_limit=0, repeat_limit=0, limit_answers=False)


class HelperTests(unittest.TestCase):
    def test_hedges_need_punctuation_after_wait(self):
        self.assertEqual(m.count_hedges("Wait, no. But wait, yes. Hmm. Hold on."), 4)
        self.assertEqual(m.count_hedges("Wait until the lock is released, then wait for the reply."), 0)
        self.assertEqual(m.count_hedges("Let me reconsider. Let me double-check that."), 2)

    def test_repeated_sentences_need_six_words(self):
        text = "The cat sat on the mat today. The cat sat on the mat today. Yes. Yes. Yes. The cat sat on the mat today."
        self.assertEqual(m.most_repeated_sentence(text), 3)
        self.assertEqual(m.most_repeated_sentence("Yes. Yes. Yes."), 0)

    def test_limits_default_to_the_flags_and_half_the_reply(self):
        limits = m.limits_for({}, 1000, m.SERVER_LIMITS)
        self.assertEqual(limits, m.Limits(500, 12, 3, False))

    def test_a_budget_is_held_under_the_reply_by_the_answers_reserve(self):
        limits = m.limits_for({"reasoning_budget": 16384}, 16384, m.SERVER_LIMITS)
        self.assertEqual(limits.reasoning_budget, 16384 - 2048)
        limits = m.limits_for({"reasoning_budget": 900}, 1000, m.SERVER_LIMITS)
        self.assertEqual(limits.reasoning_budget, 744)

    def test_limits_reject_the_wrong_shape(self):
        with self.assertRaises(ValueError):
            m.limits_for({"hedge_limit": True}, 1000, m.SERVER_LIMITS)
        with self.assertRaises(ValueError):
            m.limits_for({"limit_answers": "yes"}, 1000, m.SERVER_LIMITS)

    def test_a_draft_needs_every_cache_layer_to_give_tokens_back(self):
        class KVCache:
            def is_trimmable(self):
                return True

        class ArraysCache:
            def is_trimmable(self):
                return False

        self.assertIsNone(m.untrimmable_cache([KVCache(), KVCache()]))
        self.assertEqual(
            m.untrimmable_cache([KVCache(), ArraysCache()]),
            "its attention cache (ArraysCache, KVCache) cannot give tokens back",
        )

    def test_own_flags_are_split_from_the_servers(self):
        limits, rest = m.split_own_flags(["--model", "x", "--hedge-limit", "20", "--limit-answers", "--port", "1"])
        self.assertEqual(limits, m.Limits(None, 20, 3, True))
        self.assertEqual(rest, ["--model", "x", "--port", "1"])


class WatcherTests(unittest.TestCase):
    def test_the_budget_closes_the_thinking_and_the_answer_is_free(self):
        w = watcher(m.Limits(reasoning_budget=32, hedge_limit=0, repeat_limit=0, limit_answers=False))
        out, history = drive(w, [5] * 40)
        self.assertEqual(w.state.phase, "reasoning")
        self.assertEqual(w.state.closing, 0)
        self.assertEqual(allowed(out), {THINK_END})
        history.append(THINK_END)
        out = call(w, history)
        self.assertEqual(w.state.phase, "answer")
        # Everything but opening the thinking again, which the cut forbids.
        self.assertEqual(allowed(out), set(range(WIDTH)) - {THINK_START})
        self.assertIsNone(w.cut, "closing the thinking is not a cut")

    def test_hedges_cut_the_thinking_but_not_the_answer_by_default(self):
        limits = m.Limits(reasoning_budget=0, hedge_limit=4, repeat_limit=0, limit_answers=False)
        w = watcher(limits)
        drive(w, [1, 5, 2, 5, 1, 5, 2, 5] + [5] * 8)
        self.assertEqual(w.state.closing, 0, "four hedges while thinking close it")
        w = watcher(limits, initial="start")
        out, _ = drive(w, [1, 5, 2, 5, 1, 5, 2, 5] + [5] * 8)
        self.assertEqual(w.state.phase, "answer")
        self.assertFalse(w.state.ending, "the answer is left alone unless asked")
        self.assertIsNone(w.cut)

    def test_hedges_end_a_plain_answer_when_asked(self):
        limits = m.Limits(reasoning_budget=0, hedge_limit=4, repeat_limit=0, limit_answers=True)
        w = watcher(limits, initial="start")
        out, _ = drive(w, [1, 5, 2, 5, 1, 5, 2, 5] + [5] * 8)
        self.assertTrue(w.state.ending)
        self.assertEqual(allowed(out), {EOS})
        self.assertIn("second-guessed", w.cut)

    def test_repeats_end_a_plain_answer_when_asked(self):
        limits = m.Limits(reasoning_budget=0, hedge_limit=0, repeat_limit=3, limit_answers=True)
        w = watcher(limits, initial="start")
        drive(w, [3, 3, 3] + [5] * 13)
        self.assertTrue(w.state.ending)
        self.assertIn("repeated", w.cut)

    def test_hedges_in_a_json_answer_close_the_string_then_run_compact(self):
        limits = m.Limits(reasoning_budget=0, hedge_limit=4, repeat_limit=0, limit_answers=True)
        self.matcher = FakeMatcher()
        with with_fake_matcher(self):
            w = watcher(limits, grammar=object(), initial="start")
            out, history = drive(w, [1, 5, 2, 5, 1, 5, 2, 5] + [5] * 8)
            self.assertEqual(allowed(out), {QUOTE}, "one step of closers only")
            self.assertFalse(w.state.closing_string)
            self.assertIn("second-guessed", w.cut)
            history.append(QUOTE)
            out = call(w, history)
            self.assertNotIn(SPACE, allowed(out), "compact from then on")
            self.assertIn(5, allowed(out))

    def test_a_rewind_takes_back_tokens_their_text_and_what_the_grammar_was_fed(self):
        limits = m.Limits(reasoning_budget=0, hedge_limit=4, repeat_limit=0, limit_answers=True)
        self.matcher = FakeMatcher()
        with with_fake_matcher(self):
            w = watcher(limits, grammar=object(), initial="start")
            _, history = drive(w, [5, 6, 7, 8])
            self.assertEqual(self.matcher.fed, [5, 6, 7, 8])
            # The draft guessed 7 and 8; the main model rejected them.
            history = history[:-2]
            call(w, history)
            self.assertEqual(w.reply, [5, 6])
            self.assertEqual(self.matcher.fed, [5, 6])
            self.assertEqual(self.matcher.rolled_back, 2)
            self.assertEqual(w.state.consumed, 2)
            # New tokens after the rewind are judged from the restored state.
            history += [9, 10]
            call(w, history)
            self.assertEqual(w.reply, [5, 6, 9, 10])
            self.assertEqual("".join(w.pieces), " w5 w6 w9 w10")

    def test_a_rewind_restores_the_phase_and_the_budget_count(self):
        w = watcher(m.Limits(reasoning_budget=0, hedge_limit=0, repeat_limit=0, limit_answers=False), initial="start")
        _, history = drive(w, [THINK_START, 5, 5, THINK_END, 6])
        self.assertEqual(w.state.phase, "answer")
        # The draft guessed the close and the answer's first token; both rejected.
        history = history[:-2]
        call(w, history)
        self.assertEqual(w.state.phase, "reasoning")
        self.assertEqual(w.state.reasoning_tokens, 2)
        self.assertEqual(w.reply, [THINK_START, 5, 5])

    def test_a_rewind_past_the_first_token_restores_the_initial_state(self):
        w = watcher(NO_LIMITS, initial="start")
        _, history = drive(w, [THINK_START, 5])
        call(w, history[:-2])
        self.assertEqual(w.state.phase, "start")
        self.assertEqual(w.reply, [])

    def test_a_history_that_parted_from_the_reply_is_read_again_from_there(self):
        w = watcher(NO_LIMITS, initial="start")
        _, history = drive(w, [5, 6, 7])
        # Same length, different last token: not a prefix cut, which mlx_lm
        # never does today, but what the guard is for.
        history[-1] = 8
        with self.assertLogs(level="WARNING") as logs:
            call(w, history)
        self.assertEqual(w.reply, [5, 6, 8])
        self.assertIn("parted from the reply at token 2", logs.output[0])

    def test_a_request_fails_when_the_generation_thread_has_died(self):
        from queue import Queue

        class DeadThread:
            def is_alive(self):
                return False

        gen = m.Generator.__new__(m.Generator)
        gen.requests = Queue()
        gen._generation_thread = DeadThread()
        m.CLIENT_POLL_SECONDS = 0.05
        try:
            with self.assertRaises(RuntimeError):
                gen.generate(object(), None)
        finally:
            m.CLIENT_POLL_SECONDS = 0.5

    def test_masks_cover_the_main_models_width_even_when_the_draft_calls_first(self):
        w = watcher(NO_LIMITS, initial="reasoning")
        narrow = mx.zeros((1, WIDTH - 8))
        w(mx.array([100, 101, 102]), narrow)
        self.assertEqual(w.mask.shape[1] * 32 >= WIDTH, True)
        out = w(mx.array([100, 101, 102, 5]), mx.zeros((1, WIDTH)))
        self.assertNotIn(EOS, allowed(out))
        self.assertIn(WIDTH - 1, allowed(out))


class LenientToolParameters(unittest.TestCase):
    """A parameter the parser cannot convert comes through as text."""

    def test_a_value_the_parser_rejects_is_passed_as_the_text(self):
        def strict(value, name, config):
            if name == "count":
                return int(value)
            if name == "size":
                raise OverflowError("too large to hold")
            raise SyntaxError("not a literal")

        lenient = m.lenient_param_value(strict)
        self.assertEqual(lenient("3", "count", {}), 3)
        self.assertEqual(lenient("regex.txt", "path", {}), "regex.txt")
        self.assertEqual(lenient('{"a": 1} trailing', "body", {}), '{"a": 1} trailing')
        self.assertEqual(lenient("1e400", "size", {}), "1e400")

    def test_the_qwen_parser_no_longer_fails_a_request_on_a_bad_value(self):
        # Drive the whole parser, not _convert_param_value on its own, so
        # this still catches the 502 if an upstream change stops the parse
        # path from going through the wrapped function.
        from mlx_lm.tool_parsers import qwen3_coder

        tools = [
            {
                "function": {
                    "name": "run",
                    "parameters": {
                        "properties": {
                            "path": {"type": "filename"},
                            "body": {"type": "object"},
                            "size": {"type": "number"},
                        }
                    },
                }
            }
        ]

        def parse(param_name, param_value):
            call = f"<function=run><parameter={param_name}>{param_value}</parameter></function>"
            return qwen3_coder.parse_tool_call(call, tools)["arguments"][param_name]

        original = qwen3_coder._convert_param_value
        try:
            m.make_tool_parsers_lenient()
            # An unknown type used to be read as a Python literal, and a
            # plain word is not one.
            self.assertEqual(parse("path", "regex.txt"), "regex.txt")
            # An object with text after it used to fail as JSON, then as a literal.
            self.assertEqual(parse("body", '{"a": 1} and more'), '{"a": 1} and more')
            # A number too large to hold used to overflow to infinity.
            self.assertEqual(parse("size", "1e400"), "1e400")
            # A value that reads fine is still converted.
            self.assertEqual(parse("body", '{"a": 1}'), {"a": 1})
        finally:
            qwen3_coder._convert_param_value = original


class HarmonyTokenizer:
    """The tokens gpt-oss spells its channels with, and nothing else."""

    ids = {
        "<|channel|>": 100, "<|message|>": 101, "<|start|>": 102, "<|end|>": 103,
        "<|call|>": 104, "<|return|>": 105, "<|constrain|>": 106,
        "analysis": 110, "final": 111, "commentary": 112, "assistant": 113,
        " to=functions": 114,
    }

    def __init__(self):
        self._think_start = None
        self._eos = {104, 105}

    def get_vocab(self):
        return dict(self.ids)

    def encode(self, text, add_special_tokens=False):
        out = []
        while text:
            for word, token in sorted(self.ids.items(), key=lambda kv: -len(kv[0])):
                if text.startswith(word):
                    out.append(token)
                    text = text[len(word):]
                    break
            else:
                raise ValueError(text)
        return out

    @property
    def eos_token_ids(self):
        return self._eos

    def convert_ids_to_tokens(self, token):
        return {v: k for k, v in self.ids.items()}[token]

    def decode(self, tokens):
        return "".join(self.convert_ids_to_tokens(t) for t in tokens)

    @property
    def think_start_tokens(self):
        return self._think_start_tokens

    @property
    def think_end_tokens(self):
        return self._think_end_tokens

    @property
    def think_start(self):
        return self._think_start

    @property
    def think_end(self):
        return self._think_end

    @property
    def tool_call_start_tokens(self):
        return self._tool_call_start_tokens

    @property
    def tool_call_start(self):
        return self._tool_call_start


class HarmonyTests(unittest.TestCase):
    def test_a_tokenizer_with_the_channel_tokens_is_taught_the_markers(self):
        t = HarmonyTokenizer()
        m.teach_harmony(t)
        self.assertEqual(t.think_start_tokens, (100, 110, 101))
        self.assertEqual(t.think_end_tokens, (103,))
        self.assertEqual(t.tool_call_start_tokens, (100, 112, 114))
        self.assertIsNone(t._tool_call_end)
        self.assertEqual(t._harmony_tool_openers, [(100, 112, 114), (100, 110, 114), (114,)])
        self.assertEqual(set(t._harmony_drops), {(102, 113), (100, 111, 101), (100, 112, 101), (103,)})
        self.assertEqual(t._harmony_headers, [(102, 113, 100, 111, 101), (100, 111, 101)])
        # Once only: a second call leaves it as it is.
        t._think_start_tokens = ()
        m.teach_harmony(t)
        self.assertEqual(t.think_start_tokens, ())

    def test_a_tokenizer_without_the_tokens_is_left_alone(self):
        t = HarmonyTokenizer()
        t.ids = {"<think>": 1}
        m.teach_harmony(t)
        self.assertIsNone(t._think_start)

    def test_a_tool_call_is_read_however_the_recipient_was_written(self):
        # The recipient in the channel header.
        call = m.parse_harmony_tool_call('.getTemperature <|constrain|>json<|message|>{"city": "Oslo"}', None)
        self.assertEqual(call, {"name": "getTemperature", "arguments": {"city": "Oslo"}})
        # The recipient in the role header, as the template renders past calls.
        call = m.parse_harmony_tool_call('.get_weather<|channel|>commentary json<|message|>{"a": 1}', None)
        self.assertEqual(call, {"name": "get_weather", "arguments": {"a": 1}})
        call = m.parse_harmony_tool_call('.get_weather<|channel|>commentary <|constrain|>json<|message|>{"a": 1}', None)
        self.assertEqual(call, {"name": "get_weather", "arguments": {"a": 1}})
        # No content type, and arguments that are not JSON, still come through.
        call = m.parse_harmony_tool_call(".run<|message|>ls -la", None)
        self.assertEqual(call, {"name": "run", "arguments": {"raw": "ls -la"}})
        with self.assertRaises(ValueError):
            m.parse_harmony_tool_call("just some text", None)

    def test_thinking_off_becomes_the_lowest_effort(self):
        self.assertEqual(
            m.harmony_template_kwargs({"enable_thinking": False}),
            {"enable_thinking": False, "reasoning_effort": "low"},
        )
        self.assertEqual(
            m.harmony_template_kwargs({"enable_thinking": False, "reasoning_effort": "high"}),
            {"enable_thinking": False, "reasoning_effort": "high"},
        )
        self.assertEqual(m.harmony_template_kwargs(None), {})

    def run_machine(self, tokens):
        t = HarmonyTokenizer()
        gen = object.__new__(m.Generator)
        gen._state_machine_cache = {}
        machine, sequences = m.Generator._make_state_machine(gen, "k", t, [], "normal")
        self.assertEqual(sequences[(100, 111, 101)], "<|channel|>final<|message|>")
        state = machine.make_state()
        seen = []
        for token in tokens:
            state, matched, current = machine.match(state, token)
            seen.append((matched is not None, current))
        return seen

    def test_the_state_machine_splits_thinking_from_the_answer(self):
        # analysis … <|end|> <|start|>assistant <|channel|>final<|message|> hi <|return|>
        seen = self.run_machine([100, 110, 101, 7, 103, 102, 113, 100, 111, 101, 8, 105])
        self.assertEqual(seen[2], (True, "reasoning"))
        self.assertEqual(seen[3], (False, "reasoning"))
        self.assertEqual(seen[4], (True, "normal"))
        self.assertEqual(seen[6], (True, "normal"), "the turn marker is dropped")
        self.assertEqual(seen[9], (True, "normal"), "the final header is dropped")
        self.assertEqual(seen[10], (False, "normal"), "the answer stays")
        self.assertEqual(seen[11], (True, None))

    def test_a_tool_call_opens_either_way_and_ends_on_the_call_token(self):
        # The recipient in the channel header, at the reply's start.
        seen = self.run_machine([100, 112, 114, 9, 104])
        self.assertEqual(seen[2], (True, "tool"))
        self.assertEqual(seen[3], (False, "tool"))
        self.assertEqual(seen[4], (True, None))
        # The recipient in the role header, after thinking.
        seen = self.run_machine([100, 110, 101, 7, 103, 102, 113, 114, 9, 100, 112, 5, 101, 9, 104])
        self.assertEqual(seen[6], (True, "normal"), "the turn marker is dropped")
        self.assertEqual(seen[7], (True, "tool"), "the recipient opens the call")
        self.assertEqual(seen[-1], (True, None))
        # A lone channel token is not yet any marker.
        self.assertEqual(self.run_machine([100])[0], (False, "normal"))

    def test_a_call_made_from_the_analysis_channel_is_a_call_and_leaves_no_header_behind(self):
        # <|channel|>analysis to=functions .Bash <|message|> … <|call|>
        # Seen from gpt-oss-120b under Claude Code: without this opener the
        # header reached the client as the text "<|channel|>analysis".
        seen = self.run_machine([100, 110, 114, 9, 101, 9, 104])
        self.assertEqual(seen[0], (False, "normal"))
        self.assertEqual(seen[1], (False, "normal"), "analysis alone is not yet a marker")
        self.assertEqual(seen[2], (True, "tool"), "the recipient makes it a call")
        self.assertEqual(seen[-1], (True, None))
        # The same two tokens followed by the message marker still open thinking.
        self.assertEqual(self.run_machine([100, 110, 101])[2], (True, "reasoning"))

    def test_a_preamble_stays_in_the_text_and_the_call_after_it_is_still_a_call(self):
        # <|channel|>commentary<|message|> hi <|end|> <|start|>assistant <|channel|>commentary to=functions … <|call|>
        seen = self.run_machine([100, 112, 101, 7, 103, 102, 113, 100, 112, 114, 9, 104])
        self.assertEqual(seen[2], (True, "normal"), "the preamble's header is dropped")
        self.assertEqual(seen[3], (False, "normal"), "its text stays")
        self.assertEqual(seen[4], (True, "normal"), "its end is dropped")
        self.assertEqual(seen[9], (True, "tool"))
        self.assertEqual(seen[11], (True, None))

    def test_a_stop_inside_a_tool_call_is_handed_over_as_normal_so_the_call_is_filed(self):
        stop = m.server.Response("", 104, None, (104,), 0.0, "stop", ())
        filed = m.file_tool_call_on_stop("tool", stop)
        self.assertEqual((filed.state, filed.token, filed.finish_reason, filed.match), ("normal", 104, "stop", (104,)))
        # The same token, so nothing is added to the reply's count. Not for
        # a stop after the answer, nor for a token inside the call.
        self.assertIs(m.file_tool_call_on_stop("normal", stop), stop)
        inside = m.server.Response("x", 9, "tool", None, 0.0, None, ())
        self.assertIs(m.file_tool_call_on_stop("tool", inside), inside)


class MultiTokenThinkingStart(unittest.TestCase):
    def test_a_reply_that_only_starts_like_the_marker_is_the_answer(self):
        w = watcher(NO_LIMITS, initial="start")
        w.think_start = (THINK_START, 5, 6)
        w.step(THINK_START)
        self.assertEqual(w.state.phase, "start")
        w.step(9)
        self.assertEqual(w.state.phase, "answer")
        self.assertEqual(w.state.judged_from, 0)

    def test_the_whole_marker_opens_thinking(self):
        w = watcher(NO_LIMITS, initial="start")
        w.think_start = (THINK_START, 5, 6)
        for token in (THINK_START, 5):
            w.step(token)
            self.assertEqual(w.state.phase, "start")
        w.step(6)
        self.assertEqual(w.state.phase, "reasoning")


class AnswerHeader(unittest.TestCase):
    """Harmony writes a final-channel header between the thinking and the
    answer. Under a grammar it is let through and not fed to the grammar,
    and a reply may open with it instead of thinking."""

    HEADER = (20, 21, 22)
    # After thinking the header comes behind the turn marker; at the reply's
    # start it comes on its own.
    HEADERS = [(19,) + HEADER, HEADER]

    def test_after_the_thinking_the_header_may_come_and_then_only_json(self):
        self.matcher = FakeMatcher()
        with with_fake_matcher(self):
            w = watcher(NO_LIMITS, grammar=object(), initial="reasoning")
            w.answer_headers = self.HEADERS
            # Thinking closes; the header's first token is allowed beside the JSON.
            out, history = drive(w, [1, 2, THINK_END])
            self.assertEqual(w.state.phase, "answer")
            self.assertEqual(w.state.header, 0)
            self.assertTrue({19, 20, 5} <= allowed(out))
            # Once begun, only the rest of that header may come.
            history.append(19)
            out = call(w, history)
            self.assertEqual(allowed(out), {20})
            history.append(20)
            out = call(w, history)
            self.assertEqual(allowed(out), {21})
            history += [21, 22]
            out = call(w, history)
            self.assertIsNone(w.state.header)
            self.assertIn(5, allowed(out))
            history.append(5)
            call(w, history)
            # Only the answer reached the grammar; the header was passed over.
            self.assertEqual(self.matcher.fed, [5])
            self.assertEqual(w.judged_text(), w.piece_for(5))

    def test_an_answer_that_skips_the_header_is_judged_at_once(self):
        self.matcher = FakeMatcher()
        with with_fake_matcher(self):
            w = watcher(NO_LIMITS, grammar=object(), initial="reasoning")
            w.answer_headers = self.HEADERS
            drive(w, [1, THINK_END, 5, 6])
            self.assertIsNone(w.state.header)
            self.assertEqual(self.matcher.fed, [5, 6])

    def test_a_reply_may_open_with_the_header_instead_of_thinking(self):
        self.matcher = FakeMatcher()
        with with_fake_matcher(self):
            w = watcher(NO_LIMITS, grammar=object(), initial="start")
            w.think_start = (THINK_START, 30, 31)
            w.answer_headers = self.HEADERS
            out, history = drive(w, [])
            self.assertTrue({THINK_START, 20, 5} <= allowed(out))
            history.append(20)
            out = call(w, history)
            self.assertEqual(w.state.phase, "start")
            self.assertEqual(allowed(out), {21})
            history += [21, 22]
            call(w, history)
            self.assertEqual(w.state.phase, "answer")
            self.assertIsNone(w.state.header)
            history.append(5)
            call(w, history)
            self.assertEqual(self.matcher.fed, [5])

    def test_a_partial_thinking_marker_may_only_be_completed(self):
        self.matcher = FakeMatcher()
        with with_fake_matcher(self):
            w = watcher(NO_LIMITS, grammar=object(), initial="start")
            w.think_start = (THINK_START, 30, 31)
            out, history = drive(w, [THINK_START])
            self.assertEqual(allowed(out), {30})
            history += [30, 31]
            call(w, history)
            self.assertEqual(w.state.phase, "reasoning")


class ReopenedThinking(unittest.TestCase):
    """A format whose reply is several messages can open thinking again
    after the answer began. Under the budget it counts on; once the budget
    has cut the thinking, the marker may not be completed."""

    def test_thinking_opened_again_goes_on_counting(self):
        # The budget is checked every CHECK_EVERY tokens of the reply.
        limits = m.Limits(reasoning_budget=24, hedge_limit=0, repeat_limit=0, limit_answers=False)
        w = watcher(limits, initial="reasoning")
        w.think_start = (THINK_START, 30, 31)
        _, history = drive(w, [1] * 16 + [THINK_END])
        self.assertEqual(w.state.phase, "answer")
        self.assertEqual(w.state.reasoning_tokens, 17)
        self.assertFalse(w.state.thought_cut)
        history += [THINK_START, 30, 31]
        for _ in range(3):
            call(w, history[: len(history) - 2])
        call(w, history)
        self.assertEqual(w.state.phase, "reasoning")
        self.assertEqual(w.state.reasoning_tokens, 17, "the marker itself is not thinking")
        # Twelve more tokens of thinking: 29 in all, past the budget of 24,
        # at the next check.
        for token in [2] * 12:
            history.append(token)
            call(w, history)
        self.assertEqual(w.state.reasoning_tokens, 29)
        self.assertTrue(w.state.thought_cut)

    def test_after_a_cut_the_marker_may_not_be_completed(self):
        limits = m.Limits(reasoning_budget=16, hedge_limit=0, repeat_limit=0, limit_answers=False)
        w = watcher(limits, initial="reasoning")
        w.think_start = (THINK_START, 30, 31)
        out, history = drive(w, [1] * 16)
        self.assertTrue(w.state.thought_cut)
        self.assertEqual(allowed(out), {THINK_END}, "the close is forced")
        history.append(THINK_END)
        out = call(w, history)
        self.assertEqual(w.state.phase, "answer")
        # The marker's first token may also start something else, so it is
        # allowed; the next one, which commits the reply to thinking, is not.
        self.assertIn(THINK_START, allowed(out))
        history.append(THINK_START)
        out = call(w, history)
        self.assertNotIn(30, allowed(out))
        self.assertIn(5, allowed(out))

    def test_after_a_cut_a_one_token_marker_is_refused_outright(self):
        # Qwen's `<think>` is one token, so there is no partial marker to
        # wait for: the token is refused anywhere in the answer.
        limits = m.Limits(reasoning_budget=16, hedge_limit=0, repeat_limit=0, limit_answers=False)
        w = watcher(limits, initial="reasoning")
        _, history = drive(w, [1] * 16)
        self.assertTrue(w.state.thought_cut)
        history += [THINK_END, 5]
        out = call(w, history)
        self.assertEqual(w.state.phase, "answer")
        self.assertNotIn(THINK_START, allowed(out))
        self.assertIn(5, allowed(out))

    # Harmony's shape: the thinking marker (`<|channel|>analysis<|message|>`)
    # shares its first token with the final header, and after thinking both
    # come behind the turn marker (`<|start|>assistant`), here token 19.
    HARMONY_THINK = (20, 30, 31)
    HARMONY_HEADERS = [(19, 20, 21, 22), (20, 21, 22)]

    def test_thinking_reopened_behind_the_turn_marker_is_seen(self):
        w = watcher(NO_LIMITS, initial="reasoning")
        w.think_start = self.HARMONY_THINK
        w.answer_headers = self.HARMONY_HEADERS
        _, history = drive(w, [1, THINK_END])
        self.assertEqual(w.state.header, 0)
        # The first two tokens look like the final header; the third does not.
        history += [19, 20, 30, 31]
        call(w, history)
        self.assertEqual(w.state.phase, "reasoning")

    def test_after_a_cut_thinking_may_not_reopen_behind_the_turn_marker(self):
        limits = m.Limits(reasoning_budget=16, hedge_limit=0, repeat_limit=0, limit_answers=False)
        w = watcher(limits, initial="reasoning")
        w.think_start = self.HARMONY_THINK
        w.answer_headers = self.HARMONY_HEADERS
        _, history = drive(w, [1] * 16)
        self.assertTrue(w.state.thought_cut)
        history += [THINK_END, 19, 20]
        out = call(w, history)
        self.assertEqual(w.state.phase, "answer")
        # `analysis` is refused; `final` is still open.
        self.assertNotIn(30, allowed(out))
        self.assertIn(21, allowed(out))


class NoThinking(unittest.TestCase):
    def test_a_reply_without_thinking_is_watched_as_the_answer(self):
        w = watcher(NO_LIMITS, initial="normal", tokenizer=NoThinkingTokenizer())
        out, _ = drive(w, [1, 5, THINK_START, 6])
        self.assertEqual(w.state.phase, "answer")
        self.assertEqual(len(allowed(out)), WIDTH)


class OneSystemMessage(unittest.TestCase):
    def test_several_system_messages_become_one_at_the_front(self):
        messages = [
            {"role": "system", "content": "You are helpful."},
            {"role": "system", "content": [{"type": "text", "text": "Be brief."}]},
            {"role": "user", "content": "hi"},
            {"role": "system", "content": "Late rule."},
            {"role": "assistant", "content": "hello"},
        ]
        self.assertEqual(
            m.one_system_message(messages),
            [
                {"role": "system", "content": "You are helpful.\n\nBe brief.\n\nLate rule."},
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
            ],
        )

    def test_a_conversation_that_is_already_right_is_left_alone(self):
        messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]
        self.assertIs(m.one_system_message(messages), messages)
        no_system = [{"role": "user", "content": "u"}]
        self.assertIs(m.one_system_message(no_system), no_system)
        self.assertIsNone(m.one_system_message(None))


if __name__ == "__main__":
    unittest.main()


class ReasoningEffort(unittest.TestCase):
    def test_the_top_level_effort_reaches_the_template_kwargs(self):
        body = m.fold_reasoning_effort({"messages": [], "reasoning_effort": "high"})
        self.assertEqual(body["chat_template_kwargs"], {"reasoning_effort": "high"})

    def test_an_unknown_level_becomes_the_nearest_known_one(self):
        self.assertEqual(m.fold_reasoning_effort({"reasoning_effort": "xhigh"})["chat_template_kwargs"]["reasoning_effort"], "high")
        self.assertEqual(m.fold_reasoning_effort({"reasoning_effort": "minimal"})["chat_template_kwargs"]["reasoning_effort"], "low")

    def test_an_explicit_kwarg_wins_and_no_effort_changes_nothing(self):
        body = {"reasoning_effort": "high", "chat_template_kwargs": {"reasoning_effort": "low"}}
        self.assertEqual(m.fold_reasoning_effort(body)["chat_template_kwargs"], {"reasoning_effort": "low"})
        plain = {"messages": []}
        self.assertIs(m.fold_reasoning_effort(plain), plain)
        default = {"reasoning_effort": "default"}
        self.assertIs(m.fold_reasoning_effort(default), default, "'default' leaves the template to its own default")
