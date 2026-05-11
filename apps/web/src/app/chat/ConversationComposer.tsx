import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, RefreshCw, Send, Square, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { useStreamStore } from "../stores/stream-store";
import type { RuntimeProps } from "./conversation-model";
import { filesToDraftImageAttachments, formatAttachmentSize, formatAttachmentType, isImageFile } from "./conversation-model";

type ConversationComposerProps = Pick<
  RuntimeProps,
  "refreshMessages" | "sendMessage" | "cancelCurrentRun"
> & {
  isRunning: boolean;
  isSwitchingSessionAgent: boolean;
};

export const ConversationComposer = memo(function ConversationComposer(props: ConversationComposerProps) {
  const draftMessage = useStreamStore((state) => state.draftMessage);
  const draftAttachments = useStreamStore((state) => state.draftAttachments);
  const setDraftMessage = useStreamStore((state) => state.setDraftMessage);
  const setDraftAttachments = useStreamStore((state) => state.setDraftAttachments);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const hasDraftMessage = draftMessage.trim().length > 0;
  const hasDraftAttachments = draftAttachments.length > 0;
  const canSend = !props.isSwitchingSessionAgent && (hasDraftMessage || hasDraftAttachments);
  const inputPlaceholder = props.isRunning
    ? "当前 run 正在执行，回车会先加入队列，也可以拖入图片"
    : props.isSwitchingSessionAgent
    ? "Updating session agent…"
    : "Message the current session or drop images here";

  const submitDraft = useCallback(() => {
    const message = draftMessage;
    const attachments = draftAttachments;
    if (message.trim().length === 0 && attachments.length === 0) {
      return;
    }

    if (textareaRef.current) {
      textareaRef.current.value = "";
      textareaRef.current.style.height = "auto";
    }
    setDraftMessage("");
    setDraftAttachments([]);
    props.sendMessage({ message, attachments });
  }, [draftAttachments, draftMessage, props.sendMessage, setDraftAttachments, setDraftMessage]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [draftMessage]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (canSend) {
          submitDraft();
        }
      }
    },
    [canSend, submitDraft]
  );

  const appendAttachments = useCallback(
    async (files: FileList | File[]) => {
      const nextAttachments = await filesToDraftImageAttachments(files);
      if (nextAttachments.length === 0) {
        return;
      }

      setDraftAttachments((current) => [...current, ...nextAttachments]);
    },
    [setDraftAttachments]
  );

  const handleFileSelection = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) {
        return;
      }

      await appendAttachments(files);
      event.target.value = "";
    },
    [appendAttachments]
  );

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
      event.preventDefault();
      setIsDraggingFiles(true);
    }
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDraggingFiles(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsDraggingFiles(false);
  }, []);

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      if (event.dataTransfer.files.length === 0) {
        return;
      }

      event.preventDefault();
      setIsDraggingFiles(false);
      await appendAttachments(event.dataTransfer.files);
    },
    [appendAttachments]
  );

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const imageFiles = [...event.clipboardData.files].filter(isImageFile);
      if (imageFiles.length === 0) {
        return;
      }

      event.preventDefault();
      await appendAttachments(imageFiles);
    },
    [appendAttachments]
  );

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      setDraftAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    },
    [setDraftAttachments]
  );

  return (
    <div
      className={`conversation-composer pointer-events-auto relative rounded-2xl px-3 pb-3 pt-2 shadow-lg transition ${isDraggingFiles ? "ring-2 ring-sky-400/60" : ""} ${
        draftAttachments.length > 0 ? "mt-28" : ""
      }`}
      style={{
        background: "color-mix(in srgb, var(--background) 80%, transparent)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid color-mix(in srgb, var(--foreground) 12%, transparent)"
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileSelection}
      />
      {draftAttachments.length > 0 ? (
        <div className="pointer-events-none absolute inset-x-3 bottom-full mb-3 overflow-x-auto">
          <div className="pointer-events-auto flex min-w-max items-end gap-2 pr-6">
            {draftAttachments.map((attachment) => (
              <div
                key={attachment.id}
                className="group relative flex h-[92px] w-[92px] shrink-0 overflow-hidden rounded-2xl border border-white/35 bg-background/92 shadow-[0_16px_36px_-26px_rgba(15,23,42,0.45)] ring-1 ring-black/5 backdrop-blur"
              >
                <img src={attachment.previewUrl} alt={attachment.name} className="h-full w-full object-cover" />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 via-black/25 to-transparent px-2 pb-2 pt-5 text-white">
                  <div className="truncate text-[11px] font-medium">{attachment.name}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-white/80">
                    <span>{formatAttachmentType(attachment.mediaType)}</span>
                    <span className="h-1 w-1 rounded-full bg-white/55" />
                    <span>{formatAttachmentSize(attachment.size)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeAttachment(attachment.id)}
                  className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/45 bg-black/45 text-white shadow-sm transition hover:bg-black/65"
                  aria-label={`Remove ${attachment.name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <Button
          onClick={props.refreshMessages}
          variant="ghost"
          size="icon"
          className="h-9 w-9 flex-shrink-0"
          title="Refresh messages"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button
          onClick={() => fileInputRef.current?.click()}
          size="icon"
          variant="ghost"
          className="h-9 w-9 flex-shrink-0"
          title="Attach images"
        >
          <ImagePlus className="h-4 w-4" />
        </Button>

        <div className="flex-1">
          <Textarea
            ref={textareaRef}
            value={draftMessage}
            onChange={(event) => setDraftMessage(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={inputPlaceholder}
            disabled={props.isSwitchingSessionAgent}
            rows={1}
            className="min-h-[24px] max-h-[200px] flex-1 resize-none border-none bg-transparent px-0 py-2.5 text-sm shadow-none outline-none focus-visible:ring-0 disabled:opacity-50"
          />
        </div>

        {!props.isRunning || canSend ? (
          <Button
            onClick={submitDraft}
            disabled={!canSend}
            size="icon"
            className="shadow-elegant h-9 w-9 flex-shrink-0"
            title="Send message"
          >
            <Send className="h-4 w-4" />
          </Button>
        ) : null}

        {props.isRunning ? (
          <Button
            onClick={props.cancelCurrentRun}
            size="icon"
            variant="ghost"
            className="h-9 w-9 flex-shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
            title="Stop run"
          >
            <Square className="h-4 w-4 fill-current" />
          </Button>
        ) : null}
      </div>

      {isDraggingFiles ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border border-dashed border-sky-400/60 bg-sky-500/10">
          <span className="rounded-full border border-sky-300/40 bg-background/92 px-3 py-1 text-xs font-medium text-foreground shadow-sm">
            Drop images to attach
          </span>
        </div>
      ) : null}
    </div>
  );
});
