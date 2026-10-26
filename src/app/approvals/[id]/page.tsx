import { ApprovalPage } from "./approval-page";

// The manager's page from the approval email: no login, the signed link (?t=) is the credential.
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { id } = await params;
  const { t } = await searchParams;
  return <ApprovalPage id={id} token={t ?? null} />;
}
