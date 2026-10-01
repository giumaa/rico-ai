import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** within this distance new tokens keep the view pinned to the bottom */
const FOLLOW_PX = 120;
/** farther than this from the bottom → show the "jump to latest" button */
const SHOW_BUTTON_PX = 200;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Chat auto-scroll.
 *  - Follows streamed content only while the user is already near the bottom (never yanks them back).
 *  - `atBottom` turns false past ~200px, driving the floating button; `hasNew` marks content that
 *    arrived while the user was scrolled up (dot on the button).
 *  - `signal` changes whenever content changes; `resetKey` when another chat opens (jump instantly).
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, signal: unknown, resetKey: unknown) {
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const first = useRef(true);

  const scrollToBottom = useCallback(
    (behavior?: ScrollBehavior) => {
      const el = ref.current;
      if (!el) return;
      stick.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: behavior ?? (reducedMotion() ? 'auto' : 'smooth') });
      setAtBottom(true);
      setHasNew(false);
    },
    [ref],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      stick.current = gap < FOLLOW_PX;
      const near = gap < SHOW_BUTTON_PX;
      setAtBottom((prev) => (prev === near ? prev : near));
      if (near) setHasNew(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);

  // End key jumps to the latest message (unless the user is typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'End' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('.modal, .lightbox, .onb')) return;
      e.preventDefault();
      scrollToBottom();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scrollToBottom]);

  // new content: follow it, or flag it when the user has scrolled away
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
    } else if (!first.current) {
      setHasNew(true);
    }
    first.current = false;
  }, [ref, signal]);

  // another chat opened
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    stick.current = true;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setHasNew(false);
  }, [ref, resetKey]);

  return { atBottom, hasNew, scrollToBottom };
}
