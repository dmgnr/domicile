---
"domicile": patch
---

`domicile mcp --http` treats every session of a chat that names itself in a tool call's `_meta["openai/session"]` as one agent, so ChatGPT asks once per chat and shows one pill instead of one per tool call.
