# Playtest 08: Web UI Walkthrough

**Mission**: Use the web UI as if you're a new user who found it. No docs,
no curl — just the browser. Report the experience.

**Time**: ~15 min

## Entry point

Start the web UI: `cd smolvm-web && deno task serve`

Open `http://localhost:3000` (or whatever port). Just start clicking.

## Things to explore

- What do you see first? Is the purpose of the app obvious?
- Can you create a sandbox? Is the form intuitive? What fields are required?
- Can you pick a starter image? Is it obvious what they provide?
- Run a command. Is there a terminal/console? Is the UX good or clunky?
- Run a command that fails. How is the error displayed?
- Run a slow command. Is there any loading state or does it feel frozen?
- Navigate between multiple sandboxes. Is the list/detail flow natural?
- Stop, start, delete a sandbox. Are the buttons where you'd expect?
- Try the file browser (if it exists). Can you browse, read, create files?
- Resize the browser window. Does it work on narrow screens?
- Open dev tools. Any JS errors? Any failed requests? Slow loads?
- Refresh the page. Does state persist or do you lose context?

## Specific UX questions

- If you showed this to a coworker, could they use it without explanation?
- What's the most confusing part?
- What's missing that you expected to find?
- Would you use this or just use curl/SDK?
- Does it feel like a prototype or a product?

## What we're really testing

- First-use experience without documentation
- UI completeness — can you do everything the API can?
- Error states and loading states
- Polish level — is this embarrassing or presentable?
