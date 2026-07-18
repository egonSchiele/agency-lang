---
name: "usaspending"
description: "USASpending — U.S. federal awards"
---

# usaspending

## USASpending — U.S. federal awards

  Query [USASpending](https://api.usaspending.gov), the U.S. Treasury's award-level spending API:
  which companies and organizations received federal contracts and grants, from which agency, for
  how much. Use it to follow federal money — pairs with `std::data/people/littlesis` (who is
  connected) and `std::data/finance/edgar` (company filings).

  No API key required. `usaspendingAwards` searches; its results carry a `generatedId` you can drill
  into with `usaspendingAward`, which also surfaces recipient executive compensation and sub-award
  totals.

  ### Usage

  ```ts
  import { usaspendingAwards } from "std::data/usaspending"

  node main() {
    const awards = usaspendingAwards(recipient: "Lockheed Martin", limit: 5) catch []
    for (a in awards) {
      print("${a.amount}  ${a.recipient}  (${a.awardingAgency})")
    }
  }
  ```

## Types

### Award

One federal award from a search. `generatedId` drills into usaspendingAward; `amount` is USD.

```ts
/** One federal award from a search. `generatedId` drills into usaspendingAward; `amount` is USD. */
export type Award = {
  internalId: number;
  generatedId: string;
  id: string;
  recipient: string;
  amount: number;
  awardingAgency: string;
  startDate: string;
  endDate: string;
  description: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/usaspending.agency#L46))

### Executive

A recipient officer and their compensation.

```ts
/** A recipient officer and their compensation. */
export type Executive = {
  name: string;
  amount: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/usaspending.agency#L59))

### AwardDetail

Curated detail for one federal award.

```ts
/** Curated detail for one federal award. */
export type AwardDetail = {
  id: string;
  category: string;
  awardType: string;
  description: string;
  amount: number;
  recipient: string;
  recipientUei: string;
  awardingAgency: string;
  startDate: string;
  endDate: string;
  placeOfPerformance: string;
  subawardCount: number;
  subawardAmount: number;
  executives: Executive[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/usaspending.agency#L65))

## Effects

### std::usaspending

```ts
effect std::usaspending {
  op: string;
  query: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/usaspending.agency#L30))

## Functions

### usaspendingAwards

```ts
usaspendingAwards(
  recipient: string = "",
  agency: string = "",
  awardType: string = "contracts",
  startDate: string = "",
  endDate: string = "",
  limit: number = 20,
): Result<Award[]> raises <std::usaspending, std::http::fetchJSON>
```

Search U.S. federal awards. Returns each award's id, recipient, amount, awarding agency, dates, and
  description, most-funded first. An empty result set returns an empty list.

  @param recipient - Recipient or company name to filter by (blank = any)
  @param agency - Awarding agency name to filter by (blank = any)
  @param awardType - Award category: contracts, grants, loans, direct_payments, or other
  @param startDate - ISO start date bounding the award period; only applied when endDate is also set
  @param endDate - ISO end date bounding the award period; only applied when startDate is also set
  @param limit - Maximum number of awards to return

**Parameters:**

| Name | Type | Default |
|---|---|---|
| recipient | `string` | "" |
| agency | `string` | "" |
| awardType | `string` | "contracts" |
| startDate | `string` | "" |
| endDate | `string` | "" |
| limit | `number` | 20 |

**Returns:** `Result<Award[]>`

**Throws:** `std::usaspending`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/usaspending.agency#L229))

### usaspendingAward

```ts
usaspendingAward(
  awardId: string,
): Result<AwardDetail> raises <std::usaspending, std::http::fetchJSON>
```

Fetch full detail for one federal award. Returns amount, recipient and UEI, awarding agency, dates,
  place of performance, sub-award totals, and recipient executive compensation. Unknown id returns a
  failure.

  @param awardId - The award id: the generatedId from a search, or the numeric internalId as a string

**Parameters:**

| Name | Type | Default |
|---|---|---|
| awardId | `string` |  |

**Returns:** `Result<AwardDetail>`

**Throws:** `std::usaspending`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/usaspending.agency#L252))
