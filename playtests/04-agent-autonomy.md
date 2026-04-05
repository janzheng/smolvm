# Playtest 04: Agent Autonomy

**Mission**: Put Claude Code inside a machine and give it a real programming
task. See if it can work autonomously — install deps, write code, run tests,
iterate on failures.

**Time**: ~30 min

## Entry point

Create a machine from `claude-code` starter with 2+ GB RAM, networking enabled.
Inject your ANTHROPIC_API_KEY via env.

## Missions to assign the agent

Pick one or more, in increasing difficulty:

### Easy: "Create a CLI calculator in Python with tests"
```
claude -p "Create a Python CLI calculator that supports +, -, *, /.
Include pytest tests. Run the tests and fix any failures."
```
- Does it create files? Run pytest? Fix failures? How many iterations?

### Medium: "Build a REST API with a database"
```
claude -p "Build a FastAPI app with SQLite that has CRUD endpoints for
a todo list. Include at least 3 test cases. Run the tests."
```
- Does it install FastAPI and uvicorn? Create the DB? Run tests?
- If tests fail, does it iterate and fix them?

### Hard: "Clone a repo and add a feature"
```
claude -p "Clone https://github.com/expressjs/express, read the README,
then create a minimal example app in /home/agent/my-app that uses Express
with 3 routes: GET /, GET /health, POST /echo. Add tests with supertest."
```
- Does git clone work? Can it npm install in the cloned repo?
- Does it understand the library from reading source?

### Boss level: "Debug a broken project"
Upload a deliberately broken project via the file API first, then:
```
claude -p "There's a project in /workspace/broken-app. It should be a
working Express server but it has bugs. Find and fix all the bugs, then
prove it works by running it and curling the endpoints."
```

## Things to watch for

- Does the agent hit resource limits? (memory, disk, timeout)
- Does networking work for git clone, npm install, pip install?
- How long do tasks take? Is exec timeout generous enough?
- Does the agent's output come back cleanly, or is it truncated/garbled?
- Can you snapshot the agent's work afterward and restore it later?
- Does clone + diff work to see what the agent changed?

## What we're really testing

- smolvm as an agent execution environment (the core use case)
- Whether the claude-code starter has everything an agent needs
- Timeout and resource limits for long-running agent tasks
- The full loop: create machine → agent works → snapshot results → compare
