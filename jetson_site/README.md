# Jetson Native Site Client

A headless/native site publisher intended to run on NVIDIA Jetson devices.

Features:
- Command line arguments for site ID, signaling URL, and media device selection.
- Uses `wrtc` for headless WebRTC PeerConnection.
- Grabs video frames from a GStreamer pipeline (Jetson-optimized) via `child_process` piping into a `MediaStreamTrack` (future work placeholder) or falls back to synthetic test pattern.
- Audio optional (disabled by default).
- Adaptive bitrate control reacting to promote messages.

## Usage

Install dependencies:
```
npm install
```
Run:
```
node jetson_site.js --siteId camera-1 --signal ws://server:8080 \
  --video "nvarguscamerasrc ! video/x-raw(memory:NVMM),width=1280,height=720,framerate=30/1 ! nvvidconv ! videoconvert ! video/x-raw,format=I420 ! appsink" 
```
Arguments:
- --siteId <id>           (required)
- --signal <wsUrl>        (default ws://localhost:8080)
- --video <gstPipeline>   (optional; if omitted uses synthetic video)
- --name <displayName>    (optional name)
- --maxHigh <bps>         (default 2000000)
- --maxLow <bps>          (default 300000)

## TODO
- Implement actual GStreamer -> RTCVideoSource piping.
- Add hardware H264 encoding negotiation.
