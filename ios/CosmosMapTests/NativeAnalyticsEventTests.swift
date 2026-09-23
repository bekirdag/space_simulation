import XCTest
@testable import CosmosMap

final class NativeAnalyticsEventTests: XCTestCase {
    func testValidEventKeepsStringAndNumberParameters() throws {
        let event = try XCTUnwrap(NativeAnalyticsEvent(messageBody: [
            "name": "travel_to",
            "params": ["target": "Mars", "type": "planet", "count": NSNumber(value: 3), "ratio": NSNumber(value: 0.5)],
        ] as [String: Any]))
        XCTAssertEqual(event.name, "travel_to")
        XCTAssertEqual(event.parameters["target"], "Mars" as NSString)
        XCTAssertEqual(event.parameters["count"], NSNumber(value: 3))
        XCTAssertEqual(event.parameters["ratio"], NSNumber(value: 0.5))
    }

    func testMissingParamsIsAllowed() throws {
        let event = try XCTUnwrap(NativeAnalyticsEvent(messageBody: ["name": "search"] as [String: Any]))
        XCTAssertTrue(event.parameters.isEmpty)
        XCTAssertNotNil(NativeAnalyticsEvent(messageBody: ["name": "search", "params": NSNull()] as [String: Any]))
    }

    func testRejectsInvalidNamesAndBodies() {
        for name in ["", "1abc", "_abc", "has space", "dash-name", "é", String(repeating: "a", count: 41),
                     "firebase_x", "google_x", "ga_x"] {
            XCTAssertNil(NativeAnalyticsEvent(messageBody: ["name": name] as [String: Any]), name)
        }
        XCTAssertNotNil(NativeAnalyticsEvent(messageBody: ["name": String(repeating: "a", count: 40)] as [String: Any]))
        XCTAssertNil(NativeAnalyticsEvent(messageBody: "travel_to"))
        XCTAssertNil(NativeAnalyticsEvent(messageBody: ["name": 5] as [String: Any]))
        XCTAssertNil(NativeAnalyticsEvent(messageBody: ["name": "ok", "params": [1, 2]] as [String: Any]))
    }

    func testRejectsMoreThan25Parameters() {
        let params = Dictionary(uniqueKeysWithValues: (0..<26).map { ("p\($0)", NSNumber(value: $0)) })
        XCTAssertNil(NativeAnalyticsEvent(messageBody: ["name": "many", "params": params] as [String: Any]))
        let allowed = Dictionary(uniqueKeysWithValues: (0..<25).map { ("p\($0)", NSNumber(value: $0)) })
        XCTAssertEqual(NativeAnalyticsEvent(messageBody: ["name": "many", "params": allowed] as [String: Any])?.parameters.count, 25)
    }

    func testDropsUnsupportedValuesAndTruncatesLongStrings() throws {
        let event = try XCTUnwrap(NativeAnalyticsEvent(messageBody: [
            "name": "open_info",
            "params": [
                "long": String(repeating: "x", count: 150),
                "nested": ["a": 1],
                "list": [1, 2],
                "nothing": NSNull(),
                "bad key": "v",
                "nan": NSNumber(value: Double.nan),
                "flag": NSNumber(value: true),
            ] as [String: Any],
        ] as [String: Any]))
        XCTAssertEqual((event.parameters["long"] as? String)?.count, 100)
        XCTAssertEqual(event.parameters["flag"], NSNumber(value: 1))
        XCTAssertEqual(Set(event.parameters.keys), ["long", "flag"])
    }
}
