export function readableTime(ms: number) {
  const totalSeconds = ms / 1000;

  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    return hours + (hours === 1 ? " hour" : " hours");
  }
  // Otherwise, if there are at least 60 seconds, show minutes only.
  else if (totalSeconds >= 60) {
    const minutes = Math.floor(totalSeconds / 60);
    return minutes + (minutes === 1 ? " minute" : " minutes");
  }
  // Otherwise, show seconds.
  else {
    return totalSeconds + (totalSeconds === 1 ? " second" : " seconds");
  }
}
