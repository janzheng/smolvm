# Playtest 07: SDK Ergonomics

**Mission**: Use the TypeScript SDK to build a small automation script. Not
testing correctness — testing whether the API design is pleasant to use.

**Time**: ~20 min

## Entry point

Open `sdk-ts/`. Read `mod.ts`. Write a script that does something real.

## Build this

Write a Deno script that:
1. Creates a sandbox
2. Writes a small project into it (multiple files)
3. Runs the project
4. Captures and displays the output
5. Cleans up

Don't copy examples. Just use the types and see if you can figure it out.

## Things to notice

- Is the import path obvious? Can you find `SmolvmClient` easily?
- Does TypeScript autocomplete guide you, or do you need to read source?
- Method names: are they what you'd guess? `exec` vs `execute` vs `run`?
- Error handling: what happens when you forget to await? When the server is
  down? When a sandbox doesn't exist?
- Is the sandbox object stateful or do you pass names around?
- File write/read: is the base64 encoding obvious or surprising?
- Can you chain operations fluently or is it verbose?
- Compare: how would this look with raw `fetch()` calls? Is the SDK worth it?

## Bonus challenges

- Write a "sandbox pool" — create 5 sandboxes, run different commands in
  parallel, collect all results
- Write a "workspace sync" — mirror a local directory into a sandbox using
  the file API
- Write an "experiment runner" — clone a base sandbox, run a task in the
  clone, diff against base, print the diff

## What we're really testing

- API surface area: too much? too little? missing methods?
- Naming and conventions: idiomatic TypeScript?
- Error messages: helpful or opaque?
- Types: do they help or get in the way?
- The "aha" moment: how fast do you go from "I don't know this SDK" to
  "I'm productive"?
