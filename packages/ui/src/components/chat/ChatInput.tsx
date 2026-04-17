'use client';

import {
  useState,
  useRef,
  useCallback,
  useLayoutEffect,
  DragEvent,
  ClipboardEvent,
  KeyboardEvent,
} from 'react';

interface ImageAttachment {
  id: string;
  dataUrl: string;
  mimeType: string;
  name: string;
}

interface TextAttachment {
  id: string;
  content: string;
  charCount: number;
}

interface ChatInputProps {
  onSend: (text: string, agentName?: string) => void;
  isDisabled: boolean;
}

const AGENT_OPTIONS = ['default'] as const;
const LARGE_PASTE_THRESHOLD = 500;
const MAX_TEXTAREA_HEIGHT = 240;

const SendIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const XIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function uid() {
  return Math.random().toString(36).slice(2);
}

export function ChatInput({ onSend, isDisabled }: ChatInputProps) {
  const [text, setText] = useState('');
  const [agentName, setAgentName] = useState<string>(AGENT_OPTIONS[0]);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [textAttachments, setTextAttachments] = useState<TextAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCounterRef = useRef(0);

  // Sync textarea height with content — runs before paint to avoid flicker
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [text]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    const hasAttachments = images.length > 0 || textAttachments.length > 0;
    if ((!trimmed && !hasAttachments) || isDisabled) return;

    // Build full message: inline text attachments + user text
    const parts: string[] = [];
    for (const ta of textAttachments) {
      parts.push(`<pasted-text>\n${ta.content}\n</pasted-text>`);
    }
    if (trimmed) parts.push(trimmed);

    const fullText = parts.join('\n\n');
    onSend(fullText, agentName === 'default' ? undefined : agentName);
    setText('');
    setImages([]);
    setTextAttachments([]);
  }, [text, isDisabled, onSend, agentName, images, textAttachments]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        handleSend();
      }
      // Shift+Enter: default textarea behavior inserts newline
    },
    [handleSend],
  );

  const processImageFile = useCallback(async (file: File) => {
    const dataUrl = await readFileAsDataUrl(file);
    setImages((prev) => [
      ...prev,
      { id: uid(), dataUrl, mimeType: file.type, name: file.name },
    ]);
  }, []);

  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const { clipboardData } = e;
      if (!clipboardData) return;

      // Image paste
      const imageFiles = Array.from(clipboardData.files).filter((f) =>
        f.type.startsWith('image/'),
      );
      if (imageFiles.length > 0) {
        e.preventDefault();
        for (const file of imageFiles) {
          await processImageFile(file);
        }
        return;
      }

      // Also check clipboardData.items for image/png from screenshot
      const imageItems = Array.from(clipboardData.items).filter(
        (item) => item.kind === 'file' && item.type.startsWith('image/'),
      );
      if (imageItems.length > 0) {
        e.preventDefault();
        for (const item of imageItems) {
          const file = item.getAsFile();
          if (file) await processImageFile(file);
        }
        return;
      }

      // Large text paste → attachment chip
      const pastedText = clipboardData.getData('text/plain');
      if (pastedText.length >= LARGE_PASTE_THRESHOLD) {
        e.preventDefault();
        setTextAttachments((prev) => [
          ...prev,
          { id: uid(), content: pastedText, charCount: pastedText.length },
        ]);
        return;
      }

      // Small paste: default behavior
    },
    [processImageFile],
  );

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounterRef.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);

      const { dataTransfer } = e;

      // Dropped image files
      const imageFiles = Array.from(dataTransfer.files).filter((f) =>
        f.type.startsWith('image/'),
      );
      for (const file of imageFiles) {
        await processImageFile(file);
      }

      // Dropped text
      const droppedText = dataTransfer.getData('text/plain');
      if (droppedText && imageFiles.length === 0) {
        if (droppedText.length >= LARGE_PASTE_THRESHOLD) {
          setTextAttachments((prev) => [
            ...prev,
            { id: uid(), content: droppedText, charCount: droppedText.length },
          ]);
        } else {
          setText((prev) => (prev ? prev + droppedText : droppedText));
        }
      }
    },
    [processImageFile],
  );

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const removeTextAttachment = useCallback((id: string) => {
    setTextAttachments((prev) => prev.filter((ta) => ta.id !== id));
  }, []);

  const hasContent = text.trim() || images.length > 0 || textAttachments.length > 0;
  const hasAttachments = images.length > 0 || textAttachments.length > 0;

  return (
    <div className="border-t border-[#1f1f1f] p-4 bg-[#0a0a0a]">
      <div className="max-w-3xl mx-auto">
        <div
          className={`bg-[#111111] border rounded-2xl px-4 py-3 transition-colors ${
            isDragging
              ? 'border-[#7c3aed] bg-[#7c3aed]/5'
              : 'border-[#2d2d2d] focus-within:border-[#7c3aed]/50'
          }`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {/* Drag overlay hint */}
          {isDragging && (
            <div className="text-center text-sm text-[#a78bfa] py-2 pointer-events-none">
              Drop image or text here
            </div>
          )}

          {/* Attachment chips */}
          {!isDragging && hasAttachments && (
            <div className="flex flex-wrap gap-2 mb-2">
              {images.map((img) => (
                <div
                  key={img.id}
                  className="relative group flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden border border-[#2d2d2d]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    className="w-full h-full object-cover"
                  />
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="Remove image"
                  >
                    <XIcon />
                  </button>
                </div>
              ))}
              {textAttachments.map((ta) => (
                <div
                  key={ta.id}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#1a1a1a] border border-[#2d2d2d] text-xs text-[#9ca3af] max-w-[200px]"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="flex-shrink-0 text-[#6b7280]"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="truncate">
                    Pasted text ({ta.charCount.toLocaleString()} chars)
                  </span>
                  <button
                    onClick={() => removeTextAttachment(ta.id)}
                    className="flex-shrink-0 ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                    aria-label="Remove pasted text"
                  >
                    <XIcon />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input row */}
          {!isDragging && (
            <div className="flex items-end gap-3">
              {/* Agent selector */}
              <select
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                disabled={isDisabled}
                className="text-xs text-[#6b7280] bg-transparent border-none outline-none cursor-pointer hover:text-[#f0f0f0] transition-colors disabled:opacity-50 mb-0.5 flex-shrink-0"
                aria-label="Select agent"
              >
                {AGENT_OPTIONS.map((a) => (
                  <option key={a} value={a} className="bg-[#111111]">
                    {a}
                  </option>
                ))}
              </select>

              {/* Divider */}
              <div className="w-px h-4 bg-[#2d2d2d] flex-shrink-0 mb-0.5" />

              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                disabled={isDisabled}
                placeholder={isDisabled ? 'Responding…' : 'Ask anything…'}
                rows={1}
                className="flex-1 bg-transparent text-sm text-[#f0f0f0] placeholder-[#4b5563] resize-none outline-none leading-6 disabled:opacity-50 overflow-y-auto"
                style={{ minHeight: '24px', maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }}
              />

              {/* Send button */}
              <button
                onClick={handleSend}
                disabled={isDisabled || !hasContent}
                className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center bg-[#7c3aed] text-white hover:bg-[#6d28d9] disabled:opacity-30 disabled:cursor-not-allowed transition-all hover:scale-105 active:scale-95 mb-0.5"
                aria-label="Send message"
              >
                <SendIcon />
              </button>
            </div>
          )}
        </div>

        <p className="text-[10px] text-[#4b5563] text-center mt-2">
          Enter to send · Shift+Enter for new line · Paste or drop images
        </p>
      </div>
    </div>
  );
}
