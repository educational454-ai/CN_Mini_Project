import json
import secrets

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

app = FastAPI()

# Characters that are easy to confuse (O/0 and I/1) are excluded.
CODE_CHARACTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
active_sessions: dict[str, WebSocket] = {}
paired_sessions: dict[str, str] = {}


def generate_share_code() -> str:
    """Return a six-character code not used by an active session."""
    while True:
        code = "".join(secrets.choice(CODE_CHARACTERS) for _ in range(6))
        if code not in active_sessions:
            return code


@app.get("/health")
async def health():
    """Report that the server is running."""
    return {"status": "ok", "message": "ShareYou server is running"}


async def send_error(websocket: WebSocket, message: str) -> None:
    """Send a readable error response to one client."""
    await websocket.send_json({"type": "error", "message": message})


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Register a browser and handle pairing and WebRTC signaling messages."""
    await websocket.accept()
    share_code = generate_share_code()
    active_sessions[share_code] = websocket

    try:
        await websocket.send_json({"type": "share_code", "code": share_code})

        while True:
            raw_message = await websocket.receive_text()
            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                await send_error(websocket, "Message must be valid JSON.")
                continue

            if not isinstance(message, dict):
                await send_error(websocket, "Message must be a JSON object.")
                continue

            message_type = message.get("type")
            if not isinstance(message_type, str):
                await send_error(websocket, "Message type must be a string.")
                continue

            if message_type == "join":
                requested_code = message.get("code")
                if (
                    not isinstance(requested_code, str)
                    or len(requested_code) != 6
                    or any(character not in CODE_CHARACTERS for character in requested_code)
                ):
                    await send_error(
                        websocket,
                        "Share code must be six uppercase letters or digits, excluding O, 0, I, and 1.",
                    )
                    continue

                if requested_code == share_code:
                    await send_error(websocket, "You cannot pair with your own share code.")
                    continue

                peer_websocket = active_sessions.get(requested_code)
                if peer_websocket is None:
                    await send_error(websocket, "That share code is not active.")
                    continue

                if share_code in paired_sessions or requested_code in paired_sessions:
                    await send_error(websocket, "One of these clients is already paired.")
                    continue

                paired_sessions[share_code] = requested_code
                paired_sessions[requested_code] = share_code
                try:
                    await websocket.send_json(
                        {"type": "paired", "peer_code": requested_code}
                    )
                    await peer_websocket.send_json(
                        {"type": "paired", "peer_code": share_code}
                    )
                except (WebSocketDisconnect, RuntimeError):
                    paired_sessions.pop(share_code, None)
                    if paired_sessions.get(requested_code) == share_code:
                        del paired_sessions[requested_code]
                    await send_error(
                        websocket,
                        "Pairing could not be completed because the other client disconnected.",
                    )
                continue

            if message_type in {"offer", "answer"}:
                if not isinstance(message.get("sdp"), str):
                    await send_error(
                        websocket, f"{message_type} message must include an SDP string."
                    )
                    continue
                signal_fields = {"sdp": message["sdp"]}
            elif message_type == "ice-candidate":
                candidate = message.get("candidate")
                if candidate is not None and not isinstance(candidate, dict):
                    await send_error(
                        websocket,
                        "ice-candidate message must include a candidate object or null.",
                    )
                    continue
                if "candidate" not in message:
                    await send_error(websocket, "ice-candidate message must include candidate.")
                    continue
                signal_fields = {"candidate": candidate}
            else:
                await send_error(
                    websocket,
                    "Unknown message type. Use join, offer, answer, or ice-candidate.",
                )
                continue

            peer_code = paired_sessions.get(share_code)
            peer_websocket = active_sessions.get(peer_code) if peer_code else None
            if (
                peer_code is None
                or peer_websocket is None
                or paired_sessions.get(peer_code) != share_code
            ):
                if paired_sessions.get(share_code) == peer_code:
                    del paired_sessions[share_code]
                if peer_code is not None and paired_sessions.get(peer_code) == share_code:
                    del paired_sessions[peer_code]
                await send_error(
                    websocket,
                    "You must be paired with an active client to send signaling.",
                )
                continue

            try:
                await peer_websocket.send_json(
                    {"type": message_type, "from_code": share_code, **signal_fields}
                )
            except (WebSocketDisconnect, RuntimeError):
                paired_sessions.pop(share_code, None)
                if paired_sessions.get(peer_code) == share_code:
                    del paired_sessions[peer_code]
                await send_error(websocket, "The paired client disconnected.")
    except WebSocketDisconnect:
        pass
    finally:
        if active_sessions.get(share_code) is websocket:
            del active_sessions[share_code]
        peer_code = paired_sessions.pop(share_code, None)
        if peer_code is not None and paired_sessions.get(peer_code) == share_code:
            del paired_sessions[peer_code]
            peer_websocket = active_sessions.get(peer_code)
            if peer_websocket is not None:
                try:
                    await peer_websocket.send_json(
                        {"type": "peer_disconnected", "peer_code": share_code}
                    )
                except (WebSocketDisconnect, RuntimeError):
                    pass
