import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setPixelFormat("yuv420p");
Config.setCodec("h264");
// 28 with the `slow` preset and `stillimage` tuning: these are dark, largely static frames
// with sharp type, which x264 handles very efficiently. It is the difference between a
// 38 MB and a ~16 MB set of files in the repository, with no visible loss.
Config.setCrf(28);
Config.setOverwriteOutput(true);
Config.setChromiumOpenGlRenderer("swangle");
