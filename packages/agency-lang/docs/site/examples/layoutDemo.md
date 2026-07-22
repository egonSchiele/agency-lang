Showcases the terminal layouts you can build with the `std::ui/layout` module.

```ts
import { box, row, column, text, hline, vline, render } from "std::ui/layout"
import { table } from "std::ui/table"

node main() {
  /* 1) Plain bordered box with a title. */
  const greeting = box(title: "Welcome", titleColor: "orange") as b {
    b.text("Hello from std::ui/layout!", bold: true)
  }
  print(render(greeting))
  print("")
  /* 2) Two-column layout with a vline separator. */
  const twoCol = box(title: "Tips", padding: 1) as outer {
    // uses block syntax
    outer.row(gap: 2) as r {
      r.column() as left {
        left.text("Commands:", bold: true, fgColor: "orange")
        left.text("/help — show help")
        left.text("/exit — quit")
      }
      r.vline()
      r.column() as right {
        right.text("Shortcuts:", bold: true, fgColor: "orange")
        right.text("Ctrl-C — interrupt")
        right.text("Ctrl-D — submit")
      }
    }
  }
  print(render(twoCol))
  print("")
  /* 3) Box with heavy border style. */
  const heavy = box(
    title: "ALERT",
    titleColor: "red",
    borderStyle: "heavy",
    borderColor: "red",
    padding: 1,
  ) as b {
    b.text("System status nominal.", dim: true)
  }
  print(render(heavy))
  print("")
  /* 4) Simple data table. */
  const inventory = table(
    title: "Inventory",
    header: ["SKU", "Item", "Qty"],
    body: [["A-1", "Widget", "12"], ["A-2", "Gadget", "4"], ["B-9", "Sprocket", "0"]],
    footer: [["", "Total", "16"]],
  )
  print(render(inventory))
  print("")
  /* 5) Another table showing styled cells (red for negatives, green for positives) + caption. */
  const ledger = table(
    title: "Ledger",
    caption: "today",
    columns: [{
    align: "start"
  }, {
    align: "end"
  }],
    header: ["Account", "Change"],
    body: [
    ["sales", text("+450", fgColor: "green")],
    ["refunds", text("-50", fgColor: "red")],
    ["fees", text("-12", fgColor: "red")],
  ],
    footer: [["net", text("+388", fgColor: "green", bold: true)]],
  )
  print(render(ledger))
  print("")
  /* 6) Full-width three-column splash, demonstrating top-down sizing
  and text wrap inside percentage-width boxes. */
  const splash = box(width: "full", title: "Sized layout", padding: 1) as outer {
    outer.row(gap: 2) as r {
      r.box(width: "33%", title: "Commands") as b {
        b.text("/help shows the help screen")
        b.text("/exit quits the session")
      }
      r.box(width: "33%", title: "Shortcuts") as b {
        b.text("Ctrl-C interrupts the current operation")
        b.text("Ctrl-D submits the current input buffer")
      }
      r.box(width: "33%", title: "Tips") as b {
        b.text(
          "Long lines automatically wrap to fit the column width. This is a reaaaaaaallly long line of text that will wrap to the next line.",
        )
      }
    }
  }
  print(render(splash))
  print("")
  /* 7) Sized table with a fixed first column and a percentage-width notes column. */
  const sized = table(
    title: "Build summary",
    width: "full",
    columns: [{
    width: 2,
    align: "end"
  }, {}, {
    width: "30%"
  }],
    header: ["#", "file", "notes"],
    body: [
    [
    text("1"),
    text("lib/foo.ts"),
    text(
    "This is a really long string that will wrap to the next line because the column is only 30% of the table width.",
  ),
  ],
    [text("2"), text("lib/bar.ts"), text("ok")],
  ],
  )
  print(render(sized))
}
```
