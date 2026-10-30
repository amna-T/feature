import { useEffect, useState } from "react";
import { bahrainBusinessDate, untilBahrainMidnight } from "../utils/helpers.js";

/** "Business day 2026-10-30 · closes in 3h 12m": the Asia/Bahrain day that
 *  settlement will batch tonight, so a merchant knows which payout a sale
 *  lands in. */
export function BusinessDayClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const { hours, minutes } = untilBahrainMidnight(now);
  return (
    <div className="dash-dayclock" title="Settlement batches each Asia/Bahrain business day at midnight">
      <span className="dash-dayclock-dot" aria-hidden="true" />
      <span>
        Business day <strong>{bahrainBusinessDate(now)}</strong>
      </span>
      <span className="dash-dayclock-sep" aria-hidden="true">
        ·
      </span>
      <span>
        settles in{" "}
        <strong>
          {hours}h {String(minutes).padStart(2, "0")}m
        </strong>
      </span>
    </div>
  );
}
