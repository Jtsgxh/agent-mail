// Only failures before any IPC request was written are safe to retry automatically.
// A timeout or disconnect after sending may already have started an agent turn.
export function nativeConnectFailure(message, error, sent) {
  const failure = new Error(message);
  if (!sent && ["ENOENT", "ECONNREFUSED"].includes(error.code)) {
    failure.retryableNotification = true;
  }
  return failure;
}

export const notificationRetryDelays = Object.freeze([1000, 2000, 4000, 8000]);
