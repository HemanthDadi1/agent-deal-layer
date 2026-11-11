import { openDb } from "../src/db.js";
import { Platform } from "../src/service.js";
import { SimulatedEscrow } from "../src/escrow.js";

export function setup() {
  const clock = { t: Date.UTC(2026, 10, 12, 15, 0, 0) };
  const escrow = new SimulatedEscrow();
  const p = new Platform(openDb(), { escrow, now: () => clock.t });
  const advance = (ms: number) => { clock.t += ms; };
  return { p, escrow, clock, advance };
}

export const CSV = `title,category,price,stock,specs,condition,floor
macbook air m2 16gb 512gb,laptop,900,2,16GB 512GB M2,used,780
dell xps 13 16gb,laptop,700,1,16GB i7,used,610
iphone 14 128gb,phone,450,3,128GB 5G,refurbished,
`;

export function approvedVendor(p: Platform, name = "Houston Tech", auto = 0) {
  const code = p.createAccessCode();
  const v = p.signupVendor({ name, email: `${name.replace(/\W/g, "")}@x.com`, phone: "+1713555", businessId: "12-3456789", accessCode: code });
  p.decideVendor(v.vendorId, true, "docs checked");
  if (auto) p.updateVendorSettings(v.vendorId, { autoApproveUnder: auto });
  return v;
}
