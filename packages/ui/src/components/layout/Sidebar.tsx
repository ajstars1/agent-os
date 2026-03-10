'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useConversations } from '@/lib/hooks/useConversations';

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const ChatIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const MemoryIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
  </svg>
);

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const MenuIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);

const CloseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);

export function Sidebar() {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { conversations, isLoading, remove } = useConversations();

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    await remove(id);
    if (pathname === `/chat/${id}`) {
      router.push('/chat');
    }
  };

  const navItems = [
    { href: '/chat', label: 'Chat', icon: <ChatIcon /> },
    { href: '/memory', label: 'Memory', icon: <MemoryIcon /> },
  ];

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-4 border-b border-[#1f1f1f]">
        <div className="w-7 h-7 rounded-lg bg-[#7c3aed] flex items-center justify-center flex-shrink-0">
          <span className="text-white text-xs font-bold">A</span>
        </div>
        <span className="text-sm font-semibold text-[#f0f0f0]">AgentOS</span>
        <button
          onClick={() => setIsOpen(false)}
          className="ml-auto lg:hidden text-[#6b7280] hover:text-[#f0f0f0]"
          aria-label="Close sidebar"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Nav */}
      <nav className="px-3 py-3 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== '/chat' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setIsOpen(false)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                isActive
                  ? 'bg-[#7c3aed]/20 text-[#a78bfa] border border-[#7c3aed]/30'
                  : 'text-[#6b7280] hover:text-[#f0f0f0] hover:bg-[#1f1f1f]'
              }`}
            >
              <span className={isActive ? 'text-[#a78bfa]' : 'text-[#6b7280]'}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* New Chat button */}
      <div className="px-3 pb-3">
        <Link
          href="/chat"
          onClick={() => setIsOpen(false)}
          className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-md border border-[#7c3aed]/40 text-[#a78bfa] hover:bg-[#7c3aed]/10 text-xs font-medium transition-colors"
        >
          <PlusIcon />
          New Chat
        </Link>
      </div>

      {/* Conversations */}
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <p className="text-[10px] font-medium text-[#6b7280] uppercase tracking-wider mb-2 px-1">
          Recent
        </p>
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <div className="flex gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-[#6b7280] animate-pulse-dot" />
              <div className="w-1.5 h-1.5 rounded-full bg-[#6b7280] animate-pulse-dot" />
              <div className="w-1.5 h-1.5 rounded-full bg-[#6b7280] animate-pulse-dot" />
            </div>
          </div>
        )}
        {!isLoading && conversations.length === 0 && (
          <p className="text-xs text-[#6b7280] px-1 py-4 text-center">No conversations yet</p>
        )}
        <div className="space-y-0.5">
          {conversations.map((conv) => {
            const isActive = pathname === `/chat/${conv.id}`;
            return (
              <div key={conv.id} className="group relative">
                <Link
                  href={`/chat/${conv.id}`}
                  onClick={() => setIsOpen(false)}
                  className={`flex flex-col gap-0.5 px-3 py-2 rounded-md text-xs transition-colors ${
                    isActive
                      ? 'bg-[#7c3aed]/15 text-[#f0f0f0]'
                      : 'text-[#6b7280] hover:text-[#f0f0f0] hover:bg-[#1a1a1a]'
                  }`}
                >
                  <span className="font-mono text-[10px] text-[#4b5563] truncate">
                    {conv.id.slice(0, 8)}…
                  </span>
                  <span className={`text-[10px] ${isActive ? 'text-[#9ca3af]' : 'text-[#4b5563]'}`}>
                    {formatRelativeTime(conv.updatedAt)}
                  </span>
                </Link>
                <button
                  onClick={(e) => handleDelete(e, conv.id)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 rounded text-[#6b7280] hover:text-red-400 hover:bg-red-400/10 transition-all"
                  aria-label="Delete conversation"
                >
                  <TrashIcon />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setIsOpen(true)}
        className="lg:hidden fixed top-3 left-3 z-50 p-2 rounded-md bg-[#111111] border border-[#1f1f1f] text-[#6b7280] hover:text-[#f0f0f0]"
        aria-label="Open sidebar"
      >
        <MenuIcon />
      </button>

      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <div
        className={`lg:hidden fixed inset-y-0 left-0 z-50 w-64 bg-[#111111] border-r border-[#1f1f1f] transform transition-transform duration-200 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {sidebarContent}
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex flex-col w-60 bg-[#111111] border-r border-[#1f1f1f] flex-shrink-0 h-full">
        {sidebarContent}
      </aside>
    </>
  );
}
