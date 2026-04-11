import OpenClawViewPage from '@/app/pages/openclaw-view';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OpenClawViewPage instanceId={id} />;
}
