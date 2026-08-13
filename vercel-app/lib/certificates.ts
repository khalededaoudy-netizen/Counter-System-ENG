// The certificate types a ticket can be issued for — the web app's copy
// of the canonical list.
//
// `value` is the stable internal identifier stored in
// `tickets.certificate_type`; `label` is Arabic display text only.
// Never key logic off the label — rewording it must not orphan tickets
// already issued under it.
//
// MIRROR OF app/core/certificates.py (Python, desktop app). The two
// MUST stay in sync: tests/test_certificates.py parses THIS file and
// fails the suite if the values or labels drift apart, so edit both
// together.

export type CertificateType = {
  value: string;
  label: string;
};

export const CERTIFICATE_TYPES: CertificateType[] = [
  { value: "ig", label: "شهادة الدبلومه البريطانية" },
  { value: "saudi", label: "شهادة سعودية" },
  { value: "qatari", label: "شهادة قطرية" },
  { value: "bahraini", label: "شهادة بحرينية" },
  { value: "kuwaiti", label: "شهادة كويتية" },
  { value: "omani", label: "شهادة عمانية" },
  { value: "yemeni", label: "شهادة يمنية" },
  { value: "palestinian", label: "شهادة فلسطينية (توجيهي)" },
  { value: "egyptian", label: "الثانوية العامة المصرية" },
  { value: "azhar", label: "الثانوية الأزهرية" },
  { value: "emirati", label: "الشهادة الإماراتية" },
  { value: "americanDiploma", label: "الدبلومة الأمريكية" },
  { value: "other", label: "أخرى" },
];

const LABELS = new Map(CERTIFICATE_TYPES.map((c) => [c.value, c.label]));

/** Display text for a stored certificate value. Unknown/missing values
 * render as a dash rather than throwing — tickets printed before this
 * feature existed have a null certificate_type and must still show up. */
export function certificateLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return LABELS.get(value) ?? value;
}
