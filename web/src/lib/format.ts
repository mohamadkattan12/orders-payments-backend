const sarFormat = new Intl.NumberFormat("en-SA", {
  style: "currency",
  currency: "SAR",
})
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
})

/** Money is stored in halalas (1 SAR = 100 halalas). */
export const sar = (halalas: number) => sarFormat.format(halalas / 100)

export const when = (iso: string | null | undefined) =>
  iso ? timeFormat.format(new Date(iso)) : "—"
