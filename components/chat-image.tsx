"use client";

import { useEffect, useState } from "react";
import { CircleHelp, ExternalLink, ImagePlus, LoaderCircle, RefreshCw } from "lucide-react";
import type { ChatImage } from "@/lib/types";

const EXAMPLES = ["看看你的脸", "看看你的手", "看看你穿女仆装的样子"];

export function ChatImageExamples({ disabled, onChoose, hasPortrait }: { disabled: boolean; onChoose: (text: string) => void; hasPortrait: boolean }) {
  return <div className="chat-image-examples"><p><ImagePlus size={12}/>{hasPortrait ? "聊天图片会参考她的头像，点选后再发送：" : "请先在档案中生成头像，再请她发图："}</p><div>{EXAMPLES.map(text => <button type="button" key={text} disabled={disabled || !hasPortrait} onClick={() => onChoose(text)}>{text}</button>)}</div></div>;
}

export function ChatImageAttachment({ image, agentName, busy, retrying, imageReady, onRetry }: {
  image: ChatImage;
  agentName: string;
  busy: boolean;
  retrying: boolean;
  imageReady: boolean;
  onRetry: () => Promise<void>;
}) {
  // 主人，只有应用自身的头像路由才能从持久化的模型数据中加载或打开图片。
  const url = image.url && /^\/api\/portraits\/chat-[a-zA-Z0-9_-]{1,95}$/.test(image.url) ? image.url : null;
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { setLoadFailed(false); setReload(0); }, [url, image.createdAt]);

  if (image.status === "failed") return <div className="chat-image-failure" role="status"><div className="chat-image-failure-title"><CircleHelp size={15}/><strong>这张图片暂时没有生成成功</strong></div><p>{image.error || "图片服务未返回可用的结果，请稍后重新生成。"}</p><button type="button" className="button secondary small" disabled={busy || !imageReady} onClick={() => void onRetry()}>{retrying ? <LoaderCircle size={12} className="spin"/> : <RefreshCw size={12}/>} {retrying ? "正在重新生成图片…" : "重新生成图片"}</button><small>{imageReady ? "只重新生成这张图，保留原回复；会调用生图 API。" : "请先在庭院设置连接生图模型，再重试这张图片。"}</small></div>;

  if (!url) return <div className="chat-image-failure" role="status"><div className="chat-image-failure-title"><CircleHelp size={15}/><strong>图片暂时无法显示</strong></div><p>保存的图片地址无效，请重新连接庭院后查看。</p></div>;

  return <figure className="chat-image-attachment">
    {loadFailed ? <div className="chat-image-load-error" role="status"><ImagePlus size={23}/><p>图片加载失败，文字回复已保留。</p><button type="button" className="button secondary small" onClick={() => { setLoadFailed(false); setReload(value => value + 1); }}><RefreshCw size={12}/>重新加载图片</button><small>仅重新读取已保存图片，不会调用模型。</small></div> : <a className="chat-image-link" href={url} target="_blank" rel="noopener noreferrer" aria-label={`查看${agentName}发来的原图（新窗口）`}><img key={`${url}-${reload}`} src={reload ? `${url}?reload=${reload}` : url} alt={`${agentName}发来的图片：${image.request || "本次聊天的场景"}`.slice(0, 200)} width={832} height={1216} loading="lazy" onError={() => setLoadFailed(true)}/></a>}
    <figcaption><span title={image.model}><ImagePlus size={12}/>{image.reference ? "已使用头像参考" : "历史图片 · 纯文字生成"}</span><a href={url} target="_blank" rel="noopener noreferrer">查看原图<ExternalLink size={11}/></a></figcaption>
  </figure>;
}
