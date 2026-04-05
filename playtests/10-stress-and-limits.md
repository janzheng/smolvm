# Playtest 10: Stress and Limits

**Mission**: Find where smolvm breaks. Push it until something gives — then
document exactly where the limit is.

**Time**: ~30 min

## Entry point

Server running. You have curl and a script runner (bash, deno, whatever).
Start stacking pressure.

## Dimensions to stress

### Concurrency: many machines
- Create machines in a loop. 5, 10, 20, 50. Where does it slow down? Where
  does it fail? What's the error?
- Create 10 machines and exec a command in all of them simultaneously
- List machines when there are 50 of them. Is the response still fast?

### Payload: big data
- Write increasingly large files: 1KB, 100KB, 1MB, 10MB, 100MB. Where does
  the file API choke?
- Create a machine with thousands of small files. Does listing work?
- Archive a machine with 500MB of data. How long? Does it OOM?
- Upload a large tar archive. Does it work?

### Time: long-running processes
- Exec a command that takes 5 minutes. Does the HTTP request hang that long?
  Is there a timeout? Is it configurable?
- Start a background process, wait 30 minutes, check if it's still running
- Leave a machine idle for an hour. Is it still there? Does it still work?

### Speed: rapid operations
- Create and delete machines in a tight loop for 60 seconds. Does the server
  leak resources? Does it crash?
- Exec 100 quick commands (`echo $RANDOM`) in rapid succession on one machine.
  Any dropped or garbled responses?
- Clone a machine 20 times rapidly. Do all clones succeed?

### Memory: resource limits
- Create a machine with 512MB memory limit. Run something that tries to
  allocate 1GB. Is it killed cleanly?
- Create a machine with 1 CPU limit. Run a CPU-intensive task. Does it
  actually throttle?
- Check `stats` endpoint during load. Are the numbers realistic?

### Recovery: failure modes
- Kill the server while machines are running. Restart it. What state are
  the machines in? Can you recover them?
- Kill a machine's VM process directly (`kill -9`). Does the server notice?
  Does it clean up?
- Fill the host's disk. What happens to machine creation? To snapshots?
- Exhaust host memory. How does the server degrade?

## Record your findings

For each limit you find, note:
- **What broke**: exact error or behavior
- **At what scale**: number of machines, file size, etc.
- **Is it graceful**: clean error message or crash/hang?
- **Is it configurable**: can the limit be raised?

## What we're really testing

- Operational limits for capacity planning
- Graceful degradation vs hard crashes
- Resource cleanup and leak detection
- Whether the system is production-grade or demo-grade
