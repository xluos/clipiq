import { describe, expect, it } from "vitest";
import { normalizeSpiderUser, normalizeSpiderVideo } from "./douyin-spider-sidecar.cjs";

describe("douyin-spider-sidecar normalizers", () => {
  it("maps DouYin_Spider aweme summary to account video metadata", () => {
    const video = normalizeSpiderVideo({
      aweme_id: "7646974327342695330",
      desc: "图文标题",
      create_time: 1760000000,
      duration_ms: 12345,
      play_count: 1000,
      digg_count: 20,
      comment_count: 3,
      collect_count: 4,
      share_count: 5,
      cover_url: "http://example.com/cover.jpg",
      video_urls: ["https://example.com/video.mp4"],
      note_image_urls: ["https://example.com/1.jpg"],
    });

    expect(video).toMatchObject({
      id: "7646974327342695330",
      title: "图文标题",
      durationSec: 12,
      viewCount: 1000,
      likeCount: 20,
      commentCount: 3,
      collectCount: 4,
      shareCount: 5,
      externalUrl: "https://www.douyin.com/video/7646974327342695330",
      thumbnailUrl: "https://example.com/cover.jpg",
      playUrl: "https://example.com/video.mp4",
      noteImageUrls: ["https://example.com/1.jpg"],
    });
  });

  it("maps DouYin_Spider user summary to account profile metadata", () => {
    const user = normalizeSpiderUser({
      nickname: "作者",
      avatar: "http://example.com/avatar.jpg",
      signature: "简介",
      follower_count: 12,
      following_count: 3,
      aweme_count: 4,
      uid: "uid-1",
      sec_uid: "sec-1",
    });

    expect(user).toEqual({
      nickname: "作者",
      avatarUrl: "https://example.com/avatar.jpg",
      signature: "简介",
      followerCount: 12,
      followingCount: 3,
      awemeCount: 4,
      uid: "uid-1",
      secUid: "sec-1",
    });
  });
});
