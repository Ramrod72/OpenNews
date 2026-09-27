import { Check, Minus } from "lucide-react";
import type { ComparisonRow } from "@/lib/pricingContent";
import { FeatureStatusTag } from "./FeatureStatusTag";

/**
 * Every plan's full feature set, side by side. Rows come straight from
 * buildComparisonRows(), which reads the real entitlement values — this
 * table can't drift from what the database actually grants each plan.
 */
export function FeatureComparisonTable({
  planNames,
  rows,
}: {
  planNames: string[];
  rows: ComparisonRow[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <caption className="sr-only">Feature comparison across Veriqen plans</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="py-3 pr-4 text-left font-semibold">
              Feature
            </th>
            {planNames.map((name) => (
              <th key={name} scope="col" className="px-4 py-3 text-left font-semibold">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-b-0">
              <th scope="row" className="py-3 pr-4 text-left font-medium text-foreground-muted">
                {row.title}
              </th>
              {row.cells.map((cell, i) => (
                <td key={planNames[i]} className="px-4 py-3 align-top">
                  {cell.included ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Check size={16} className="shrink-0 text-accent" aria-hidden />
                      <span className="sr-only">Included: </span>
                      <span>{cell.text}</span>
                      <FeatureStatusTag status={cell.status} />
                    </div>
                  ) : (
                    <span className="flex items-center gap-1.5 text-foreground-muted">
                      <Minus size={16} aria-hidden />
                      <span className="sr-only">Not included</span>
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
