/** Liga o gatilho de proximidade e devolve a limpeza do observer. */
export function observeProgressiveImage(
  element: Element,
  onVisible: () => void,
  rootMargin: string,
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onVisible();
    return () => undefined;
  }

  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      onVisible();
      observer.disconnect();
    },
    { rootMargin },
  );
  observer.observe(element);
  return () => observer.disconnect();
}

