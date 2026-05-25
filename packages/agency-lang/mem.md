Taxonomy of Memory Approaches

There are roughly 8 categories of approaches people have built for giving agents memory beyond their context window.Different approaches work well for different situations, but overall, a hybrid approach consistently outperforms any single approach.

RAG / Vector Store Memory

Basic idea: Embed conversation history (or extracted facts) into a vector database. When the agent needs context, do a similarity search to retrieve the most relevant chunks and inject them into the prompt.

Simple to implement and scales well, but retrieval is just okay... you get similar chunks, but similar is not necessarily correct. Also has no understanding of relationships between facts, and doesn't know anything about temporal ordering. So for example, if a user comes in today and says, my favorite color is red, then two weeks later they say, my favorite color is blue, if we search for favorite color in the vector store, it doesn't know that the user has changed their favorite color.

Examples: Qdrant (what we use), Mem0, Zep
Useful for: Fine-grained fact lookups.


Summarization / Compaction
Basic idea: Ask an LLM to summarize older messages in your history to free up context. Simple but lossy. Naive summarization is imprecise about what to keep.

Examples: Claude code, LangGraph
Useful for: Simple approach for long conversations.

When does a compaction get triggered? A few options:
Token threshold: trigger when the messages are > N tokens. E.g. LangGraph trim_messages
Message count
Every turn (extract facts from every message)
Agent initiated (see tool-based memory idea below)


Short-Term vs Long-Term Memory
Basic idea: short-term memory persists for the current session, long-term memory persists across sessions. You pick and choose what you want to keep in long-term memory. Clean separation of concerns but requires explicit decisions about what gets promoted to long-term... wouldn't "just work" for the gifting assistant.


Structured Knowledge Stores (eg Knowledge Graphs)
Basic idea: similar to the vector database idea, but build structured representations -- define relationships between entities, for example. Basically a structured way to solve some of the issues we talked about with the vector store approach, like a user changing what their favorite color is.

Examples: Zep / Graphiti builds a temporal knowledge graph. Facts have time ranges they are valid for (e.g. Josh was Etsy’s CEO from 2017 to 2025). Mem0's Graph Memory, GraphRag.
Useful for: Multi-step reasoning.


Episodic Memory (Past Interactions/Events)
Basic idea: Unlike semantic memory (general facts) or short-term memory (the current interaction), episodic memory records specific past events and experiences (e.g., "what happened in yesterday's meeting").

Examples: LangChain
Useful for: Temporal reasoning.

Potential further reading: Human-inspired Episodic Memory for Infinite Context LLMs


Tool-Based Memory
Basic idea: Give the agent memory management tools like save_memory, search_memory, update_memory, delete_memory and let it decide when and what to save. The downside is it relies on the LLM's judgment about what is important.

Examples: LangMem’s create_manage_memory_tool, Letta (aka MemGPT)


Hierarchical / Tiered Memory
Basic idea: Your computer stores a small amount of information in RAM and a lot more information on disk. Apply the same idea to agent memory.
"Registers/RAM" = the context window (fast, small, expensive)
"Disk" = external storage (slow, unlimited, cheap)

The system pages information between tiers, just like an OS does.

I think this would be a really interesting thing to try building. This provides effectively unlimited memory, although the implementation could be complex.

Examples: Letta, LangChain.

LangChain provides low-level tools for this. Here's a blog post from them explaining how it works.


LLM Wikis (Karpathy)
Basic idea: have the LLM maintain a structured, indexed wiki that grows over time. Lots more info in the gist.
