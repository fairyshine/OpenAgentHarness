function formatTimestamp(value?: string) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatTimestampPrecise(value?: string) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function formatRelativeTimestamp(value?: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  const diffMs = date.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  const monthMs = 30 * dayMs;
  const yearMs = 365 * dayMs;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (absMs < minuteMs) {
    return rtf.format(Math.round(diffMs / 1000), "second");
  }

  if (absMs < hourMs) {
    return rtf.format(Math.round(diffMs / minuteMs), "minute");
  }

  if (absMs < dayMs) {
    return rtf.format(Math.round(diffMs / hourMs), "hour");
  }

  if (absMs < weekMs) {
    return rtf.format(Math.round(diffMs / dayMs), "day");
  }

  if (absMs < monthMs) {
    return rtf.format(Math.round(diffMs / weekMs), "week");
  }

  if (absMs < yearMs) {
    return rtf.format(Math.round(diffMs / monthMs), "month");
  }

  return rtf.format(Math.round(diffMs / yearMs), "year");
}

export { formatRelativeTimestamp, formatTimestamp, formatTimestampPrecise };
