# INDIALEGAL.AI Voice Agent

LiveKit Agents worker that powers the voice session.

## Local run

```
cd agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill in keys
python agent.py dev
```

## Render deploy

Background Worker service.

- Build command: `pip install -r requirements.txt`
- Start command: `python agent.py start`
- Env vars: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SARVAM_API_KEY`, `GOOGLE_API_KEY`, `NODE_URL`

The worker connects out to LiveKit Cloud and waits for room dispatch. No inbound port.
