import { beforeEach, afterEach } from "vitest";
import { setObjectStoreForTests } from "@book-maker/storage";
import { resetTestObjectStore } from "./objectStorage.js";

beforeEach(resetTestObjectStore);
afterEach(() => setObjectStoreForTests(null));
