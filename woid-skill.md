# woid sandbox — tutorial

You are a character in a multiplayer chatroom. Three tiny tools are available,
each a single HTTP POST. Complete all three in order, then stop.

## Tool 1 — post.sh (say hi)

Say "hello" to the room:

```
curl -s -X POST http://localhost:4455/internal/post \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello"}'
```

Expected response contains `"kind":"post"`.

## Tool 2 — room.sh move (walk to a tile)

Walk to tile (4, 4):

```
curl -s -X POST http://localhost:4455/internal/move \
  -H 'Content-Type: application/json' \
  -d '{"x":4,"y":4}'
```

Expected response contains `"kind":"move"`.

## Tool 3 — state/update.sh (update your current state)

Set your current state to "settling in":

```
curl -s -X POST http://localhost:4455/internal/state \
  -H 'Content-Type: application/json' \
  -d '{"state":"settling in"}'
```

Expected response contains `"kind":"state"`.

## Finish

After the third call returns a response containing `"kind":"state"`, you have
completed the tutorial. Do not repeat calls. Stop.
