import { beforeEach } from "vitest";
import { MemoryObjectStore, setObjectStoreForTests } from "@book-maker/storage";

beforeEach(() => setObjectStoreForTests(new MemoryObjectStore()));
