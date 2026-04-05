# Playtest 05: Fork and Compare

**Mission**: Use the clone/diff/merge workflow like git branching — create
a base, fork it multiple ways, compare the results, merge the best one back.
Does this actually work as a useful workflow?

**Time**: ~20 min

## Entry point

Create a sandbox called "main" with a small project in it (a few files in
/workspace). This is your "main branch."

## Scenario: parallel experiments

1. Create "main" with a base project (write 3-4 files via exec or file API)
2. Clone it 3 times: "exp-python", "exp-node", "exp-deno"
3. In each fork, implement the same thing differently:
   - exp-python: write a Python version
   - exp-node: write a Node version
   - exp-deno: write a Deno version
4. Diff each fork against "main" — do the diffs make sense? Are they useful?
5. Diff two forks against each other — does that work?
6. Pick the best one. Merge it into "main"
7. Verify "main" now has the merged code

## Things to explore

- Clone a sandbox that has installed packages (node_modules, venv). Does the
  clone include everything or just /workspace?
- Clone a running sandbox vs a stopped one. Any difference?
- Make the same file different in two forks, then try to merge both into main.
  What happens with conflicts?
- Diff a sandbox against itself. Diff against a nonexistent sandbox
- Merge with strategy "theirs" vs "ours". Is the behavior intuitive?
- Merge specific files only. Does the `files` filter work?
- Clone a clone of a clone. How deep can you go?
- Delete the original after cloning. Do the clones survive independently?

## What we're really testing

- Clone is a real deep copy (not a shallow reference)
- Diff output is useful and accurate
- Merge strategies work correctly
- Edge cases: conflicts, missing targets, circular references
- Whether this workflow is actually useful or just a gimmick
