import { futureValue, futureValueOfAnnuity, toRealDollars } from "./money.js";

/**
 * "Every dollar matters." What a spend today is worth at a target age if it
 * had stayed invested, in nominal and today's dollars.
 */
export function costOfADollar(input: {
  amount: number;
  recurring: "once" | "yearly" | "monthly";
  years: number;
  nominalReturn: number;
  inflation: number;
}) {
  let nominal: number;
  if (input.recurring === "once") {
    nominal = futureValue(input.amount, input.nominalReturn, input.years);
  } else {
    const yearly = input.recurring === "monthly" ? input.amount * 12 : input.amount;
    nominal = futureValueOfAnnuity(yearly, input.nominalReturn, input.years);
  }
  return { nominal, real: toRealDollars(nominal, input.inflation, input.years) };
}
