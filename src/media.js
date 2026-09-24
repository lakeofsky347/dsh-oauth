import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
import { listPulls } from "./pulls.js";

const PI_AI = "llm-pi-ai";

/**
 * Image and video requests run as tools against the account's media model.
 * The session's selected chat model is not changed, so the conversation continues.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
export function registerMediaTools(ctx) {
  ctx.systemPrompt.section({
    name: "oauth-media",
    order: 860,
    text: [
      "Image and video generation stay inside this conversation.",
      "When the user asks for a new image, illustration, or edit of a picture, call generate_image.",
      "When the user asks for a video or animation, call generate_video.",
      "Those tools use the image or video model pulled for this conversation's provider.",
      "Do not switch the conversation model, and do not ask the user to pick a different chat model for that request.",
    ].join(" "),
  });
  ctx.tools.register(defineTool({
    name: "generate_image",
    description: "Generate an image with the signed-in account's image model. The current conversation and its chat model stay as they are.",
    parameters: {
      prompt: { type: "string", required: true, description: "What the image should show." },
      aspect_ratio: { type: "string", description: "Optional ratio such as 1:1, 16:9, or 9:16." },
      image_url: { type: "string", description: "Optional source image URL when the user wants an edit rather than a new image." },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      return runMedia(ctx, "image", args.prompt, args.aspect_ratio, exec, undefined, args.image_url);
    },
  }));
  ctx.tools.register(defineTool({
    name: "generate_video",
    description: "Generate a short video with the signed-in account's video model. The current conversation and its chat model stay as they are.",
    parameters: {
      prompt: { type: "string", required: true, description: "What the video should show." },
      aspect_ratio: { type: "string", description: "Optional ratio such as 16:9 or 9:16." },
      duration: { type: "number", description: "Length in seconds, from 1 to 15." },
      image_url: { type: "string", description: "Optional still image URL to animate." },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      return runMedia(ctx, "video", args.prompt, args.aspect_ratio, exec, args.duration, args.image_url);
    },
  }));
}

const MEDIA_BASE = {
  xai: "https://api.x.ai/v1",
};

async function runMedia(ctx, role, prompt, aspectRatio, exec, duration, imageUrl) {
  const chatProvider = exec.agent?.options?.provider;
  const chatModel = exec.agent?.options?.model;
  const target = await mediaTarget(chatProvider, role);
  if (target === undefined) {
    throw new Error(`当前对话还没有可用的${role === "image" ? "生图" : "生视频"}模型。对话模型保持不变。`);
  }
  if (target.base === undefined) {
    throw new Error(`${target.provider} 的${role === "image" ? "生图" : "生视频"}模型还不能在当前对话里调用。对话模型保持不变。`);
  }
  const record = await ctx.credentials.readRecord(credentialKey(PI_AI, target.provider));
  const access = record?.kind === "grant" && record.payload && typeof record.payload.access === "string"
    ? record.payload.access
    : "";
  if (access.length === 0) throw new Error("OAuth 登录已失效，无法调用媒体模型。对话模型保持不变。");
  const url = role === "image"
    ? await generateImage(target.base, access, target.model, prompt, aspectRatio, imageUrl, exec.signal)
    : await generateVideo(target.base, access, target.model, prompt, aspectRatio, duration, imageUrl, exec.signal);
  const stayed = chatModel ? `当前对话模型仍是 ${chatModel}。` : "当前对话模型未改变。";
  return `已用 ${target.model} 完成${role === "image" ? "生图" : "生视频"}。${stayed}\n${url}`;
}

async function mediaTarget(chatProvider, role) {
  if (typeof chatProvider !== "string" || chatProvider.length === 0) return undefined;
  const pull = (await listPulls()).find((item) => item.id === chatProvider);
  const model = pull?.media?.find((item) => item.role === role);
  if (!model) return undefined;
  return { provider: chatProvider, model: model.id, base: MEDIA_BASE[chatProvider] };
}

async function generateImage(base, access, model, prompt, aspectRatio, imageUrl, signal) {
  const edit = typeof imageUrl === "string" && imageUrl.length > 0;
  const body = edit
    ? { model, prompt, image: { url: imageUrl, type: "image_url" } }
    : { model, prompt, response_format: "url" };
  if (typeof aspectRatio === "string" && aspectRatio.length > 0) body.aspect_ratio = aspectRatio;
  const payload = await postMedia(base, access, edit ? "/images/edits" : "/images/generations", body, signal);
  const url = payload?.data?.[0]?.url ?? payload?.url;
  if (typeof url !== "string" || url.length === 0) throw new Error("生图接口没有返回图片地址");
  return url;
}

async function generateVideo(base, access, model, prompt, aspectRatio, duration, imageUrl, signal) {
  const seconds = Number.isFinite(duration) ? Math.min(15, Math.max(1, Math.round(duration))) : 6;
  const body = { model, prompt, duration: seconds, resolution: "720p" };
  if (typeof aspectRatio === "string" && aspectRatio.length > 0) body.aspect_ratio = aspectRatio;
  if (typeof imageUrl === "string" && imageUrl.length > 0) body.image = { url: imageUrl };
  const started = await postMedia(base, access, "/videos/generations", body, signal);
  const immediate = started?.video?.url ?? started?.url;
  if (typeof immediate === "string" && immediate.length > 0) return immediate;
  const requestId = started?.request_id ?? started?.id;
  if (typeof requestId !== "string" || requestId.length === 0) throw new Error("生视频接口没有返回任务编号");
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("生视频已取消");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const status = await getMedia(base, access, `/videos/${encodeURIComponent(requestId)}`, signal);
    const url = status?.video?.url ?? status?.url;
    if (typeof url === "string" && url.length > 0) return url;
    const state = String(status?.status ?? status?.state ?? "").toLowerCase();
    if (state === "failed" || state === "error") throw new Error(status?.error ?? "生视频失败");
  }
  throw new Error("生视频超时，对话模型未改变");
}

async function postMedia(base, access, path, body, signal) {
  return mediaRequest(base, access, path, { method: "POST", body: JSON.stringify(body) }, signal);
}

async function getMedia(base, access, path, signal) {
  return mediaRequest(base, access, path, { method: "GET" }, signal);
}

async function mediaRequest(base, access, path, init, signal) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${access}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}${text ? `: ${text.slice(0, 180)}` : ""}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("媒体接口返回的不是 JSON");
  }
}
