import { redirect } from "next/navigation"

// The web app is only the operator page.
export default function Home() {
  redirect("/admin")
}
