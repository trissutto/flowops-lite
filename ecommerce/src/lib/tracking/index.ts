/**
 * PONTO DE ENTRADA DO TRACKING.
 *
 * Componente importa daqui — nunca de `destinations/` nem de `server/`.
 * Se você se pegar importando `meta-pixel` num componente, pare: é exatamente
 * o acoplamento que esta Sprint existe pra impedir.
 */

export {
  toTrackedItem,
  trackAddPaymentInfo,
  trackAddShippingInfo,
  trackAddToCart,
  trackAddToCartBlocked,
  trackAddToWishlist,
  trackAiConsultant,
  trackBeginCheckout,
  trackBodyShapeFilter,
  trackBuyAndPickup,
  trackBuyLook,
  trackColorSwitch,
  trackContact,
  trackCouponApplied,
  trackCouponRemoved,
  trackCheckoutError,
  trackCheckoutSubmission,
  trackCheckoutValidationError,
  trackCheckoutRecovered,
  trackCustom,
  trackFilterUsed,
  trackGenerateLead,
  trackInstagramClick,
  trackLogin,
  trackLogout,
  trackNewsletter,
  trackPageView,
  trackPhoneClick,
  trackPaymentMethodSelected,
  trackPaymentRetry,
  trackCardDeclined,
  trackPixCopied,
  trackPixCreated,
  trackPixExpired,
  trackQuickView,
  trackRemoveFromCart,
  trackRemoveFromWishlist,
  trackScrollDepth,
  trackSearch,
  trackSelectItem,
  trackShareProduct,
  trackSignUp,
  trackSizeGuide,
  trackSizeSwitch,
  trackSortChanged,
  trackStoreAvailability,
  trackStoreLocator,
  trackStoreReservation,
  trackTimeOnPage,
  trackVideoWatched,
  trackViewCart,
  trackViewCollection,
  trackViewFabric,
  trackViewItem,
  trackViewItemList,
  trackViewLook,
  trackViewOccasion,
  trackVirtualFitting,
  trackWhatsAppClick,
  type TrackableProduct,
} from './events';

export { initTracking, getLocalLogs, subscribeLogs } from './event-manager';
export { setUserId, setLoja } from './identity';
export { getDataLayer, subscribeDataLayer } from './data-layer';
export {
  acceptAll,
  consentBootstrapSnippet,
  getConsent,
  isAllowed,
  needsDecision,
  rejectAll,
  setConsent,
  subscribeConsent,
} from './consent';
export type { ConsentCategory, ConsentState, DispatchLog, EventName, TrackedItem, TrackingEvent } from './types';
