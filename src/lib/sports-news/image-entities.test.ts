import { describe, expect, it } from "vitest";
import { compareEntities, competitionsIn, teamsIn, topicOf } from "./image-entities";

describe("typed entities", () => {
  it("finds teams/competitions by alias, whole words only", () => {
    expect([...teamsIn("Pháo thủ thắng Man Xanh")].sort()).toEqual(["arsenal", "man city"]);
    expect(teamsIn("Ảnh đẹp trận đấu").size).toBe(0); // "anh" must not be an alias
    expect([...competitionsIn("Ngoại hạng Anh vòng 12")]).toEqual(["premier league"]);
  });
  it("classifies topics", () => {
    expect(topicOf("Arsenal thắng Man City 2-1")).toBe("match");
    expect(topicOf("Arteta họp báo trước trận")).toBe("press_conference");
    expect(topicOf("Salah ký hợp đồng mới với Liverpool")).toBe("transfer");
    expect(topicOf("Saka chấn thương dài hạn")).toBe("injury");
  });
});

describe("compareEntities", () => {
  it("matches same teams, conflicts on wrong team, single generic token is none", () => {
    expect(compareEntities("Arsenal thắng Man City", "Arsenal v Manchester City 2024")).toBe("match");
    expect(compareEntities("Arsenal thắng Man City", "Chelsea fans outside stadium")).toBe("conflict");
    expect(compareEntities("Arsenal thắng Man City", "Arsenal v Chelsea 2019")).toBe("conflict");
    expect(compareEntities("Tottenham thua", "Percy House")).toBe("none");
    expect(compareEntities("Tottenham thua Brighton", "stadium match 2020")).toBe("none");
  });
  it("matches a full person name but not a single surname token", () => {
    expect(compareEntities("Declan Rice ghi bàn", "Declan Rice portrait")).toBe("match");
    expect(compareEntities("Declan Rice ghi bàn", "Rice paddy field")).toBe("none");
  });
});
