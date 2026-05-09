// Barrel that composes the four reservations/holds modules into the
// single public factory `index.mjs` consumes. Originally one ~2.6k-line
// monolith; now four focused modules + this 50-line composition file.
//
// Module layout
// - services-reservations-shared.mjs   pure utilities, settings resolvers,
//                                      history writes, check-in pass
//                                      orchestration, read-only DDB queries,
//                                      domain predicates
// - services-payment-recording.mjs     addReservationPayment + the five
//                                      payment-link / Cash App session
//                                      state mutators
// - services-holds.mjs                 hold lifecycle (create, release,
//                                      list, listTableLocks)
// - services-reservations.mjs          reservation CRUD, cancellation,
//                                      cron overdue-release, reschedule
//                                      credit helpers
//
// Composition order: shared → paymentRecording → reservations
// (uses paymentRecording.revoke...) → holds (uses
// reservations.releaseOverdueReservationsForEventDate). Public surface
// is unchanged; index.mjs and every other caller keep the same
// `createReservationsHoldsService(deps)` signature.

import { createReservationsShared } from "./services-reservations-shared.mjs";
import { createPaymentRecordingService } from "./services-payment-recording.mjs";
import { createReservationsService } from "./services-reservations.mjs";
import { createHoldsService } from "./services-holds.mjs";

export function createReservationsHoldsService(deps) {
  const shared = createReservationsShared(deps);
  const paymentRecording = createPaymentRecordingService(deps, shared);
  const reservations = createReservationsService(deps, shared, paymentRecording);
  const holds = createHoldsService(deps, shared, {
    releaseOverdueReservationsForEventDate:
      reservations.releaseOverdueReservationsForEventDate,
  });

  return {
    // hold lifecycle
    listTableLocks: holds.listTableLocks,
    createHold: holds.createHold,
    releaseHold: holds.releaseHold,
    listHolds: holds.listHolds,
    // reservation reads + creation + cancellation + overdue release
    listReservations: reservations.listReservations,
    listReservationHistory: reservations.listReservationHistory,
    getReservationById: shared.getReservationById,
    releaseOverdueReservationsForEventDate:
      reservations.releaseOverdueReservationsForEventDate,
    releaseOverdueReservationsForAllActiveEvents:
      reservations.releaseOverdueReservationsForAllActiveEvents,
    cancelReservation: reservations.cancelReservation,
    createReservation: reservations.createReservation,
    // payment recording + payment-link / Cash App session state
    addReservationPayment: paymentRecording.addReservationPayment,
    setReservationPaymentLinkWindow:
      paymentRecording.setReservationPaymentLinkWindow,
    setReservationCashAppLinkSession:
      paymentRecording.setReservationCashAppLinkSession,
    markReservationCashAppLinkSessionUsed:
      paymentRecording.markReservationCashAppLinkSessionUsed,
    // history writes (kept on the public surface for direct external use
    // from routes-reservations-holds.mjs)
    appendReservationHistory: shared.appendReservationHistory,
  };
}
