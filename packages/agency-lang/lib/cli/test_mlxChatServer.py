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


def watcher(limits, grammar=None, initial="reasoning", matcher=None):
    tokenizer = FakeTokenizer()
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
        self.assertEqual(len(allowed(out)), WIDTH)
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
            raise SyntaxError("not a literal")

        lenient = m.lenient_param_value(strict)
        self.assertEqual(lenient("3", "count", {}), 3)
        self.assertEqual(lenient("regex.txt", "path", {}), "regex.txt")
        self.assertEqual(lenient('{"a": 1} trailing', "body", {}), '{"a": 1} trailing')

    def test_the_qwen_parser_no_longer_fails_a_request_on_a_plain_word(self):
        from mlx_lm.tool_parsers import qwen3_coder

        original = qwen3_coder._convert_param_value
        try:
            m.make_tool_parsers_lenient()
            # An unknown type used to be read as a Python literal.
            config = {"path": {"type": "filename"}}
            self.assertEqual(qwen3_coder._convert_param_value("regex.txt", "path", config), "regex.txt")
            # An object with text after it used to fail as JSON, then as a literal.
            config = {"body": {"type": "object"}}
            self.assertEqual(
                qwen3_coder._convert_param_value('{"a": 1} and more', "body", config),
                '{"a": 1} and more',
            )
            # A value that reads fine is still converted.
            self.assertEqual(qwen3_coder._convert_param_value('{"a": 1}', "body", config), {"a": 1})
        finally:
            qwen3_coder._convert_param_value = original


if __name__ == "__main__":
    unittest.main()
