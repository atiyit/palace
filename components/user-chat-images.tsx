"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, CircleHelp, ExternalLink, ImagePlus, LoaderCircle, Paperclip, RefreshCw, Trash2, X } from "lucide-react";
import type { UserImage } from "@/lib/types";
import { MAX_PENDING_USER_IMAGES, MAX_USER_IMAGE_BYTES } from "@/lib/user-profile";

const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];
function imageUrl(image: UserImage): string | null {
  return /^[a-f0-9-]{36}$/i.test(image.id) && image.url === `/api/portraits/upload-${image.id}` ? image.url : null;
}

export function UserChatImage({ image }: { image: UserImage }) {
  const url = imageUrl(image);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { setFailed(false); setReload(0); }, [url]);
  return <figure className="user-chat-image">
    {url && !failed ? <a className="user-chat-image-link" href={url} target="_blank" rel="noopener noreferrer" aria-label={`查看你上传的图片：${image.name || "聊天图片"}`}><img src={`${url}${reload ? `?reload=${reload}` : ""}`} alt={image.name ? `你上传的图片：${image.name}` : "你上传的聊天图片"} width={1536} height={1536} loading="lazy" onError={() => setFailed(true)}/></a> : <div className="user-chat-image-error"><ImagePlus size={20}/><p>{url ? "图片暂时无法加载，消息仍已保存。" : "图片地址无效，请重新连接后查看。"}</p>{url && <button type="button" className="button secondary small" onClick={() => { setFailed(false); setReload(value => value + 1); }}><RefreshCw size={12}/>重新加载图片</button>}</div>}
    <figcaption><span title={image.name}>{image.name || "你上传的图片"}</span>{url && <a href={url} target="_blank" rel="noopener noreferrer">查看原图<ExternalLink size={11}/></a>}</figcaption>
  </figure>;
}

function Thumbnail({ image }: { image: UserImage }) {
  const [failed, setFailed] = useState(false);
  const url = imageUrl(image);
  useEffect(() => setFailed(false), [url]);
  return <span className="chat-upload-thumb">{url && !failed ? <img src={url} alt="" onError={() => setFailed(true)}/> : <ImagePlus size={16}/>}</span>;
}

export function ChatUploadControls({ pending, selectedId, busy, uploading, removingId, visionEnabled, onSelect, onUpload, onRemove }: {
  pending: UserImage[];
  selectedId?: string;
  busy: boolean;
  uploading: boolean;
  removingId?: string;
  visionEnabled: boolean;
  onSelect: (imageId?: string) => void;
  onUpload: (file: File, requestId: string) => Promise<boolean>;
  onRemove: (imageId: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLDetailsElement>(null);
  const [failedFile, setFailedFile] = useState<{ file: File; requestId: string } | null>(null);
  const [error, setError] = useState("");
  const selected = pending.find(image => image.id === selectedId);
  const limitReached = pending.length >= MAX_PENDING_USER_IMAGES;

  const upload = async (file: File, requestId: string) => {
    if (busy) return;
    setError("");
    if (!ALLOWED_TYPES.includes(file.type) || !file.size || file.size > MAX_USER_IMAGE_BYTES) {
      setFailedFile(null); setError("请选择 10 MiB 以内的 PNG、JPEG 或 WebP 图片。"); return;
    }
    try {
      const ok = await onUpload(file, requestId);
      setFailedFile(ok ? null : { file, requestId });
      if (!ok) setError("图片尚未确认上传，可重新上传；不会调用文本或生图模型。");
    } catch {
      setFailedFile({ file, requestId }); setError("图片上传中断，可重新上传；不会调用模型。");
    }
  };

  return <div className="chat-upload-controls">
    <input ref={input} type="file" id="chat-image-upload" accept="image/png,image/jpeg,image/webp" hidden disabled={busy || limitReached} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (file) { setFailedFile(null); void upload(file, crypto.randomUUID()); }
    }}/>
    <div className="chat-upload-toolbar"><button type="button" className="chat-upload-button" disabled={busy || limitReached} onClick={() => input.current?.click()} aria-label="上传聊天图片">{uploading ? <LoaderCircle size={13} className="spin"/> : <Paperclip size={13}/>} {uploading ? "正在上传…" : "发图片"}</button>
      {pending.length > 0 && <details className="chat-pending-picker" ref={picker}><summary>待发图片 {pending.length}<ChevronDown size={11}/></summary><div className="chat-pending-menu"><p>选择一张加入当前消息。切换角色后可在这里重新选择。</p>{pending.map(image => <div className={`chat-pending-item ${selectedId === image.id ? "selected" : ""}`} key={image.id}><button type="button" disabled={busy} onClick={() => { onSelect(image.id); if (picker.current) picker.current.open = false; }}><Thumbnail image={image}/><span>{image.name || "聊天图片"}</span>{selectedId === image.id && <Check size={12}/>}</button><button type="button" className="icon-button" disabled={busy} onClick={() => void onRemove(image.id)} aria-label={`移除待发图片 ${image.name || "聊天图片"}`} title="移除待发图片">{removingId === image.id ? <LoaderCircle size={12} className="spin"/> : <Trash2 size={12}/>}</button></div>)}</div></details>}
      <span className="chat-upload-format">PNG / JPEG / WebP · 10 MiB</span>
    </div>
    {selected && <div className="chat-selected-image"><Thumbnail image={selected}/><div><strong>{selected.name || "待发送图片"}</strong><span>点击发送后加入当前对话</span></div><button type="button" className="icon-button" disabled={busy} onClick={() => void onRemove(selected.id)} title="移除这张待发图片" aria-label="移除当前待发图片">{removingId === selected.id ? <LoaderCircle size={13} className="spin"/> : <Trash2 size={13}/>}</button><button type="button" className="icon-button" disabled={busy} onClick={() => onSelect()} title="取消本次选择，保留在待发列表" aria-label="取消本次图片选择"><X size={14}/></button></div>}
    {error && <div className="chat-upload-error" role="alert"><CircleHelp size={12}/><span>{error}</span>{failedFile && <button type="button" disabled={busy || limitReached} onClick={() => void upload(failedFile.file, failedFile.requestId)}><RefreshCw size={11}/>重新上传</button>}<button type="button" aria-label="关闭上传提示" onClick={() => { setError(""); setFailedFile(null); }}><X size={12}/></button></div>}
    {(selected || !visionEnabled) && <p className={`chat-vision-hint ${visionEnabled ? "enabled" : ""}`}>{visionEnabled ? "图片识别已开启，发送后交给当前文本模型读取。" : "图片识别未开启：图片会保存到对话，不会交给模型解读。可在庭院设置开启。"}</p>}
    {limitReached && <p className="chat-vision-hint">待发图片已满，请先发送或移除一张。</p>}
  </div>;
}
