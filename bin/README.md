# Packaged Binaries

Put platform-specific media tools here when building desktop releases.

Expected layout:

```text
bin/
├─ win/
│  ├─ ffmpeg.exe
│  ├─ ffprobe.exe
│  └─ yt-dlp.exe
└─ mac/
   ├─ ffmpeg
   ├─ ffprobe
   └─ yt-dlp
```

Development can still use tools installed on `PATH`.
