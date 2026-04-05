# Playtest 01: First Contact

**Mission**: You've never used smolvm before. Start from zero, get a sandbox
running, poke around. Report what the onboarding experience is like.

**Time**: ~15 min

## Entry point

The server is running on `localhost:8080`. You have `curl`. Go.

## Things to explore

- Can you figure out the API without reading docs? Hit `/`, `/health`,
  `/api/v1/` — is anything discoverable?
- Create a sandbox. What happens if you don't provide a name? What if the
  JSON is malformed? What error messages do you get?
- Run `echo hello` inside it. Does the response make sense? Try `uname -a`,
  `whoami`, `ls /`, `df -h` — what does the inside of this VM look like?
- What user are you running as? Can you `sudo`? Can you install packages?
- Try `apt-get update && apt-get install -y cowsay` — does networking work?
  How long does it take?
- What's in `/workspace`? Is there a home directory?
- Stop the sandbox. What happens if you exec on a stopped sandbox? Is the
  error clear?
- Start it again. Does state persist across stop/start?
- Delete it. What happens if you delete it again? GET a deleted sandbox?

## What we're really testing

- API discoverability and error quality
- Default sandbox environment (what's pre-installed, users, filesystem)
- Stop/start/delete lifecycle edge cases
- First impressions — what feels polished vs janky
