---
name: Decision models
description: Use Jev and local Laya models through typed llm calls, read decision probabilities, batch questions, and inspect a text model's token logprobs.
---

# Decision models

Many model calls only need a small answer: is this message spam, which team should handle a ticket, or does a customer want a refund? A decision model answers these questions with probabilities. [Jev](https://docs.typesafe.ai/introduction) is a hosted decision model. [Laya](https://github.com/NandhaKishorM/laya) is an open-source alternative you can run locally and fine-tune.

In Agency, you use the same typed `llm()` calls as you would with a text model. The type describes the answers the model can give. Switching the model changes how Agency obtains those answers.

## Ask a yes/no question

Save this as `spam.agency`:

```ts
import { userMessage } from "std::thread"

node main() {
  userMessage("Congratulations! Claim your free prize by calling this number now.")
  const spam: boolean = llm("Is this message unsolicited spam?")
  print(spam)
}
```

`userMessage()` supplies the message to classify. The `llm()` prompt supplies the question. The `boolean` annotation asks for a yes/no decision. Agency returns `true` when the model's probability of yes is at least 0.5.

The same file works with a text model through [structured output](/guide/llm#structured-output). Run it with one of the decision models below to get decision probabilities as well.

## Choose a model

### Jev through OpenRouter

With your OpenRouter key in `OPENROUTER_API_KEY`, run:

```bash
TYPESAFE_API_KEY="$OPENROUTER_API_KEY" \
TYPESAFE_BASE_URL="https://openrouter.ai/api" \
  agency run --model typesafe/jev-1.13 spam.agency
```

The `typesafe` provider selects the decision API protocol. The base URL chooses the server that handles it. For this route, `TYPESAFE_API_KEY` must contain an **OpenRouter-issued key**. Setting that key without the OpenRouter base URL sends it to the wrong server and can produce a 401 authentication error.

If you use TypeSafe directly, use its key and omit the OpenRouter base URL. On the command line, the `typesafe/` prefix lets Agency select a decision model outside its text-model catalog.

### Laya locally

Install Laya's HTTP server in a Python environment and start its English checkpoint:

```bash
python3 -m venv .venv-laya
.venv-laya/bin/python -m pip install 'laya[serve]==0.3.20'
LAYA_HOST=127.0.0.1 LAYA_MODELS=english LAYA_PRELOAD=1 \
  .venv-laya/bin/laya-serve
```

The server downloads the checkpoint on first use. Leave it running, then run the Agency file from another terminal:

```bash
TYPESAFE_API_KEY=unused TYPESAFE_BASE_URL="http://127.0.0.1:8000" \
  agency run --model typesafe/english spam.agency
```

Laya speaks the same decision protocol, so Agency uses the `typesafe` provider for it too. `english` names the checkpoint served by Laya. The client requires a key value; `unused` works with a local server that has authentication disabled. If you configure `LAYA_API_KEY` on the server, put that value in `TYPESAFE_API_KEY` on the client.

### Select a model on a call

```ts
import { userMessage } from "std::thread"

node main() {
  userMessage("Congratulations! Claim your free prize now.")
  const spam: boolean = llm("Is this message unsolicited spam?", {
    model: "english",
    provider: "typesafe",
  })
  print(spam)
}
```

This call uses the same environment variables as the command-line example. For local or custom checkpoint names, include `provider: "typesafe"`. Agency already recognizes the registered Jev name `jev-1.13` as a decision model.

Keep model selection outside the call when you want to compare backends by changing only `--model`.

## Choose between labels

```ts
import { userMessage } from "std::thread"

type Department = "billing" | "support" | "sales"

node main() {
  userMessage("I cancelled two weeks ago, but my refund never arrived.")
  const department: Department = llm("Which team should handle this ticket?")
  print(department)
}
```

A union of string literals asks the model to choose one label. The returned value is a string such as `"billing"`. Choose meaningful labels: Agency currently describes each option using the label itself. You can explain distinctions between labels in the prompt.

## Ask several questions about the same input

```ts
import { userMessage } from "std::thread"

type Triage = {
  @jsonSchema({ description: "Which team should handle this ticket?" })
  department: "billing" | "support" | "sales",
  @jsonSchema({ description: "Does the customer threaten to cancel or leave?" })
  churn: boolean
}

node main() {
  userMessage("My refund never arrived. If this is not fixed today, I am leaving.")
  const triage: Triage = llm("Assess this support ticket.")
  print(triage.department)
  print(triage.churn)
}
```

Each top-level field becomes a question in one decision request. The call's prompt applies to every question, followed by the field's description. Without a description, Agency uses the field name.

The supported shapes are:

| Agency type | Decision |
| --- | --- |
| `boolean` | Yes/no, called `noul` by the decision API |
| A union of at least two string literals | Pick one option, called `choice` |
| An object whose fields use those types | One question per field |

Decision calls require a type annotation. Free-form strings, numbers, arrays, nested objects, and optional or nullable fields are not supported. Decision models cannot call tools. Agency rejects these shapes before sending a request.

The underlying APIs also have ordered `score` questions. No Agency type annotation produces one yet; annotating a value as `number` does not request a score.

## Read the probabilities

```ts
import { lastReply, userMessage, Reply, DecisionAnswer } from "std::thread"

node main() {
  userMessage("Congratulations! Claim your free prize now.")
  const spam: boolean = llm("Is this message unsolicited spam?")
  const reply: Reply | null = lastReply()
  if (reply == null || reply.answers == null) {
    return { spam: spam, needsReview: true }
  }
  const answer: DecisionAnswer = reply.answers.answer
  if (answer.type == "noul") {
    return { spam: spam, needsReview: answer.noul > 0.1 && answer.noul < 0.9 }
  }
  return { spam: spam, needsReview: true }
}
```

The boolean still uses Agency's 0.5 cutoff. This example also marks uncertain cases for review using the probability that the answer is yes, `answer.noul`. The review thresholds are illustrative; choose thresholds using labeled validation examples and the costs of each kind of mistake.

Call [`lastReply()`](/guide/message-threads#lastreply-read-a-reply-s-metadata) immediately after the decision on the same thread. It returns `null` before any assistant reply, and `reply.answers` is `null` for a normal text reply. Check an answer's `type` before reading its fields.

| Answer type | Fields |
| --- | --- |
| `noul` | `noul`: probability of yes, from 0 to 1 |
| `choice` | `choice`: selected label; `confidence`: provider-specific confidence score; `probabilities`: probability for each label |

For a single boolean or union, the answer is named `reply.answers.answer`. For the `Triage` object above, use `reply.answers.department` and `reply.answers.churn`. A choice answer's `probabilities.billing`, for example, gives the probability assigned to billing.

To read the probability of the selected label, use `answer.probabilities[answer.choice]` after checking that the answer is a `choice`. The separate `confidence` score uses [different calculations in Jev and Laya](https://github.com/NandhaKishorM/laya#self-hosting-http-server-jev-compatible), so a confidence threshold chosen for one does not transfer directly to the other.

A model's confidence can be wrong. Check how well its probabilities agree with outcomes on your own examples before using a threshold to automate decisions.

## Keep inputs separate

```ts
import { userMessage } from "std::thread"

node main() {
  const messages: string[] = ["Are we still meeting at six?", "Claim your free prize now!"]
  for (message in messages) {
    thread {
      userMessage(message)
      const spam: boolean = llm("Is this message unsolicited spam?")
      print(spam)
    }
  }
}
```

A decision model reads the current thread as its input state. Previous replies are part of that state, so use a fresh `thread` for each independent record. This prevents earlier messages and classifications from influencing the next one.

Agency sends the conversation's roles and text to the decision model. It excludes tool results and attachments. The current `llm()` prompt becomes the question; if there is no earlier conversation, Agency also uses that prompt as the state. Separating the input with `userMessage()` makes the distinction explicit.

## Batch questions with `parallel`

```ts
import { userMessage } from "std::thread"

node main() {
  userMessage("My refund never arrived. If this is not fixed today, I am leaving.")
  parallel {
    const department: "billing" | "support" | "sales" = llm("Which team should handle this?")
    const churn: boolean = llm("Does the customer threaten to leave?")
  }
  print(department)
  print(churn)
}
```

When run against a decision model, these calls share a conversation, model, and endpoint, so Agency can send their questions together. This also works inside `fork`. A model's question limit can split a group into multiple requests; Jev accepts up to 64 questions per request.

Batching combines questions about the **same state**. It does not combine unrelated messages into one state. Calls that change their conversation before asking, use different models, or run in separate nested parallel blocks form separate groups. `race` does not batch decision calls.

Each parallel branch owns its reply. To read probabilities, call `lastReply()` inside the branch, using a `seq` block or a helper function, and return the metadata you need. Reading it after the block reads the parent thread's last reply.

## Token logprobs from a text model

```ts
import { lastReply, userMessage, Reply } from "std::thread"

node main() {
  userMessage("Congratulations! Claim your free prize now.")
  const label: string = llm("Classify this message. Reply with only A for ham or B for spam.", {
    model: "gpt-4o-mini",
    provider: "openai",
    temperature: 0,
    logprobs: { top: 2 },
  })
  print(label)
  const reply: Reply | null = lastReply()
  if (reply != null) {
    for (token in reply.logprobs) {
      print(token.token)
      print(token.logprob)
      print(token.top)
    }
  }
}
```

Run this example with `OPENAI_API_KEY` set. `logprobs: {}` requests probabilities for generated tokens. Adding `top: 2` also asks for up to two alternative tokens at each position. Each entry has `token`, `logprob`, and a `top` array of alternatives with the same two fields. The current integration supports OpenAI's chat and Responses clients when the selected model supports logprobs; other providers leave the list empty.

A logprob is the natural logarithm of a token's probability. Exponentiating it gives the probability: a logprob near -2.3 corresponds to about 0.1. These values describe the model's next-token prediction, conditioned on the prompt and preceding output.

`reply.logprobs` describes output tokens. `reply.answers` describes the options in a decision question. To turn text logprobs into class probabilities, you must map output tokens to labels and account for tokenization and missing alternatives. A missing label in the returned alternatives does not mean its probability is zero. A structured output can contain JSON punctuation and several tokens per label, so its first token's probability is not the probability of the classification.

## Evaluate on your own task

Keep a fixed test set and compare accuracy alongside the mistakes that matter to your application. For spam filtering, measure both legitimate messages incorrectly flagged as spam and spam messages missed. Measure complete request latency separately from accuracy, and record whether inference ran locally or through a hosted service.

The repository's [decision-model benchmark](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/benchmarks/decision-models) includes an attributed SMS dataset, saved Jev/Laya/logprobs results, and Laya fine-tuning scripts. In that experiment, fine-tuning raised Laya's accuracy from 86.2% to 94.2% on the fixed 500-message test sample, with median latency around 40 ms in both runs. Those measurements came from direct smoltalk calls; they do not measure Agency's runtime overhead or this chapter's conversation format.

Laya fine-tuning happens outside Agency. Once you serve the trained checkpoint through Laya's decision API, the Agency code stays the same: point the provider at that server and select the checkpoint name it exposes. Keep training and validation examples separate from the final test set.
