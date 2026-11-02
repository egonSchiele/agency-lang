---
name: "usaspending"
description: "Find U.S. federal awards and inspect recipient details."
---

# usaspending

## USASpending — U.S. federal awards

  Query [USASpending](https://api.usaspending.gov), the U.S. Treasury's award-level spending API:
  which companies and organizations received federal contracts and grants, from which agency, for
  how much. Use it to research federal contracts, grants, and other awards.

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

A federal award from a search, with `amount` in USD.
    Pass `generatedId` to `usaspendingAward` to read its details.

```ts
/** A federal award from a search, with `amount` in USD.
    Pass `generatedId` to `usaspendingAward` to read its details. */
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/usaspending.agency#L47))

### Executive

A recipient officer and their compensation.

```ts
/** A recipient officer and their compensation. */
export type Executive = {
  name: string;
  amount: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/usaspending.agency#L60))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/usaspending.agency#L66))

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

Search U.S. federal awards, ordered by award amount from largest to smallest.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| recipient | `string` | "" | Match a recipient or company name, or leave empty for any recipient. |
| agency | `string` | "" | Match an awarding agency name, or leave empty for any agency. |
| awardType | `string` | "contracts" | Use contracts, grants, loans, direct_payments, or other. |
| startDate | `string` | "" | A YYYY-MM-DD award-period bound, applied only when endDate is also set. |
| endDate | `string` | "" | A YYYY-MM-DD award-period bound, applied only when startDate is also set. |
| limit | `number` | 20 |  |

**Returns:** `Result<Award[]>`

**Throws:** `std::usaspending`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/usaspending.agency#L216))

### usaspendingAward

```ts
usaspendingAward(
  awardId: string,
): Result<AwardDetail> raises <std::usaspending, std::http::fetchJSON>
```

Read one federal award's details, including subawards and executive compensation.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| awardId | `string` |  | A search result's generatedId, or its numeric internalId converted to a string. |

**Returns:** `Result<AwardDetail>`

**Throws:** `std::usaspending`, `std::http::fetchJSON`

**Needs:** `network`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/data/usaspending.agency#L238))
