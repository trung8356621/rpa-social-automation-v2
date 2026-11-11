import React from "react";
import type {
  InspectableUrl,
  UrlVerificationInfo,
} from "./PermalinkInspector";
import { UrlCandidateCard } from "./UrlCandidateCard";

export function CurrentItemUrlList({
  urls,
  selectedUrl,
  getVerification,
  copiedUrl,
  navigatingUrl,
  isLiveRunning,
  onOpen,
  onCopy,
  onUseUrl,
}: {
  urls: InspectableUrl[];
  selectedUrl: string | null;
  getVerification: (item: InspectableUrl) => UrlVerificationInfo;
  copiedUrl: string | null;
  navigatingUrl: string | null;
  isLiveRunning?: boolean;
  onOpen: (item: InspectableUrl) => void;
  onCopy: (url: string) => void;
  onUseUrl: (item: InspectableUrl) => void;
}) {
  return (
    <section className="url-inspector-block current-item-url-list">
      <div className="url-block-header">
        <h5 className="section-subtitle">
          1. Current Item URLs ({urls.length})
        </h5>
      </div>

      {urls.length === 0 ? (
        <div className="empty-url-msg">
          Không tìm thấy URL nào trong phạm vi bài hiện tại.
        </div>
      ) : (
        <div className="url-candidate-list">
          {urls.map((item) => (
            <UrlCandidateCard
              key={`${item.index}-${item.url}`}
              item={item}
              isSelected={selectedUrl === item.url}
              verification={getVerification(item)}
              isCopied={copiedUrl === item.url}
              isNavigating={navigatingUrl === item.url}
              isLiveRunning={isLiveRunning}
              onOpen={onOpen}
              onCopy={onCopy}
              onUseUrl={onUseUrl}
            />
          ))}
        </div>
      )}
    </section>
  );
}
