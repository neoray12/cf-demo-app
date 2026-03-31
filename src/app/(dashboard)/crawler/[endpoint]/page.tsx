'use client';

import { use } from "react";
import { CrawlerEndpointPage } from "@/app/pages/crawler-endpoint";

export default function CrawlerEndpointRoute({ params }: { params: Promise<{ endpoint: string }> }) {
  const { endpoint } = use(params);
  return <CrawlerEndpointPage endpoint={endpoint} />;
}
