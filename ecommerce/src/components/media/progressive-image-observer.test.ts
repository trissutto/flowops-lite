import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeProgressiveImage } from './progressive-image-observer';

afterEach(() => vi.unstubAllGlobals());

describe('observeProgressiveImage', () => {
  it('espera a interseção e usa margem antecipada de 300px', () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const onVisible = vi.fn();
    let notify: IntersectionObserverCallback = () => undefined;
    let receivedOptions: IntersectionObserverInit | undefined;
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        notify = callback;
        receivedOptions = options;
      }
      observe = observe;
      disconnect = disconnect;
    }
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);

    const element = document.createElement('span');
    const cleanup = observeProgressiveImage(element, onVisible, '300px 0px');
    expect(observe).toHaveBeenCalledWith(element);
    expect(receivedOptions).toEqual({ rootMargin: '300px 0px' });
    expect(onVisible).not.toHaveBeenCalled();

    notify([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    expect(onVisible).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    cleanup();
  });

  it('carrega imediatamente quando o navegador não oferece o observer', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const onVisible = vi.fn();
    observeProgressiveImage(document.createElement('span'), onVisible, '300px 0px');
    expect(onVisible).toHaveBeenCalledOnce();
  });
});
