import { describe, expect, it } from "vitest";

import {
  bookMatterChatAnswerSchema,
  normalizeBookMatterChatAnswer,
  type BookMatterChatAnswer,
  type BookMatterChatCurrent
} from "./bookMatterChatEdit.js";
import { normalizeReviewedMatterAnswer } from "./testing/reviewedMatterAnswer.js";

/**
 * The checks on a composed dedication or biography refuse a change, so they
 * are held to the owner's standing rule: ~99% accurate on legitimate input.
 * These suites measure that against what the composer plausibly writes.
 */

const current: BookMatterChatCurrent = {
  authorName: "Ana Ruiz",
  dedication: "For Mom",
  aboutAuthor: null,
  authorWebsite: null,
  copyrightHolder: null,
  imprint: null,
  isbn: null,
  allRightsReserved: false
};

type Change = BookMatterChatAnswer["changes"][number];
const answer = (changes: Change[]): BookMatterChatAnswer => bookMatterChatAnswerSchema.parse({ outcome: "change", changes });

/**
 * A capitalised word inside a sentence is checked as a possible name — and the
 * check refuses a change, so a false refusal drops a legitimate edit. The set
 * below is what the composer plausibly writes from the reader's facts; every
 * one must pass, and every made-up name inside a sentence must not. A capital
 * that opens a sentence is never checked by the capital heuristic; novel
 * prose passes only with an explicit complete-text grounding verdict.
 */
describe("the name check on a dedication or biography, measured", () => {
  const blank: BookMatterChatCurrent = { ...current, dedication: null };
  const kindOf = (field: "dedication" | "aboutAuthor", message: string, text: string, bookLanguage = "en", reviewed = false) =>
    (reviewed ? normalizeReviewedMatterAnswer : normalizeBookMatterChatAnswer)(answer([{ field, action: "set", text, requestedBy: message }]), { message, current: blank, bookLanguage }).kind;

  const facts =
    "write my bio: I was born and raised in Ohio, I teach chemistry at a high school, I've written two novels, I love hiking with my dog and I live with my husband and our two kids. My website is anaruiz.com";
  it.each([
    "Ana Ruiz teaches chemistry at a high school in Ohio.",
    "Born and raised in Ohio, Ana Ruiz teaches high school chemistry.",
    "Raised in Ohio, she now teaches chemistry at a high school.",
    "She has written two novels.",
    "When she isn't teaching chemistry, she loves hiking with her dog.",
    "Today she lives in Ohio with her husband and their two kids.",
    "Her two novels grew out of years in the classroom.",
    "A high school chemistry teacher, Ana Ruiz has written two novels.",
    "An avid hiker, she spends weekends on the trail with her dog.",
    "Outside the classroom, she hikes with her dog.",
    "Teaching chemistry is her day job; writing novels is her other one.",
    "Writing has always been her escape.",
    "Originally from Ohio, Ana Ruiz still lives there with her family.",
    "Currently, she teaches chemistry and writes novels.",
    "Passionate about chemistry, she brings it into her fiction.",
    "Mother of two, Ana Ruiz teaches chemistry in Ohio.",
    "Drawing on her years of teaching, she has written two novels.",
    "Inspired by her students, she began writing novels.",
    "Most weekends, she hikes with her dog.",
    "Two novels later, she still teaches chemistry.",
    "Students call her Ms. Ruiz.",
    "Readers can find her at anaruiz.com.",
    "Along with teaching, she writes novels.",
    "Married with two kids, she lives in Ohio.",
    "Whether teaching or writing, she loves a good story.",
    "Equally at home in the lab and on the trail, she lives in Ohio.",
    "Chemistry remains her first love.",
    "Happily married, Ana Ruiz lives in Ohio with her husband and two kids.",
    "Recently, she finished her second novel.",
    "Over the years, she has taught chemistry and written two novels.",
    "As a teacher, she loves chemistry. As a writer, she loves stories.",
    "Ana Ruiz was born and raised in Ohio, where she teaches chemistry. She has written two novels. When she isn't in the classroom, she hikes with her dog. She lives with her husband and their two kids.",
    "Ana Ruiz\nChemistry teacher, novelist, hiker.",
    "Living in Ohio with her husband and two kids, Ana Ruiz teaches chemistry.",
    "Fluent in chemistry and in fiction, she has written two novels.",
    "Hiking with her dog is how she spends her weekends.",
    "Ana's two novels draw on her years in the classroom.",
    "Proud mother of two, she lives in Ohio.",
    "Weekends find her on the trail with her dog.",
    "Hiking clears her head.",
    "Ana Ruiz and her husband live in Ohio with their two kids.",
    "Ohio-born Ana Ruiz teaches chemistry.",
    "High school chemistry teacher Ana Ruiz has written two novels.",
    "Novelist and chemistry teacher Ana Ruiz lives in Ohio.",
    "Novels and chemistry fill her days.",
    "Every day, she teaches chemistry.",
    "Each weekend, she hikes with her dog.",
    "Lately, she has been working on new novels.",
    "By day she teaches chemistry; by night she writes novels.",
    "Between classes, she writes.",
    "Few things make her happier than hiking with her dog.",
    "In addition to teaching, she has written two novels.",
    "Besides teaching, she writes novels.",
    "Despite a busy classroom, she has written two novels.",
    "Thanks to her students, she never runs out of stories.",
    "Somewhere between the lab and the trail, she found her stories.",
    "Here she teaches chemistry and writes novels.",
    "Ever since she was a kid, she has loved stories.",
    "Back in Ohio, she teaches chemistry.",
    "Home for Ana Ruiz is Ohio.",
    "Chemistry and storytelling have always gone together for her.",
    "Classroom life feeds her fiction.",
    "Dog walks and long hikes keep her writing.",
    "Ana Ruiz writes. She also teaches chemistry.",
    "She and her husband live in Ohio.",
    "They have two kids.",
    "Science teacher by day, novelist by night, Ana Ruiz lives in Ohio.",
    "Two novels, two kids, one dog: Ana Ruiz keeps busy in Ohio.",
    "Stories have always been part of her life.",
    "Novels are her second career.",
    "Ana Ruiz grew up in Ohio and never left."
  ])("keeps the reviewed biography %j", (text) => {
    expect(kindOf("aboutAuthor", facts, text, "en", true)).toBe("change");
  });

  const mom = "dedicate it to my mom";
  it.each([
    [mom, "For my mom"],
    [mom, "For Mom"],
    [mom, "For my mother."],
    [mom, "To my mom."],
    [mom, "For my mom, with love."],
    [mom, "With love, for my mom."],
    [mom, "Thank you, Mom."],
    [mom, "To Mom, with all my love."],
    [mom, "Mom, this one is for you."],
    [mom, "For my mom.\nThank you for everything."],
    [mom, "Forever grateful, for my mom."],
    [mom, "Always for you, Mom."],
    [mom, "Dedicated to my mom."],
    [mom, "Because of you, Mom."],
    ["dedicate it to everyone who believed in me", "To everyone who believed in me."],
    ["dedicate it to everyone who believed in me", "For everyone who believed in me."],
    ["dedicate it in memory of my grandfather", "In memory of my grandfather."],
    ["dedicate it in memory of my grandfather", "In loving memory of my grandfather."],
    ["dedicate it to my late father", "In memory of my late father."],
    ["dedicate it to my kids, never stop dreaming", "For my kids.\nNever stop dreaming."],
    ["dedicate it to my kids and tell them to keep reading", "For my kids. Keep reading."],
    ["dedicate it to my students: dream big", "For my students. Dream big."],
    ["dedicate it to my students: believe in yourselves", "To my students. Believe in yourselves."],
    ["dedicate it to my mom: sweet dreams", "For my mom. Sweet dreams."],
    ["dedicate it to my team: here's to us", "For my team. Here's to us."],
    ["dedication: For my husband. Thank you for your patience.", "For my husband. Thank you for your patience."],
    ["dedicate it to my readers with thanks", "With thanks to my readers."],
    ["dedicate it to my readers with thanks", "Thanks to my readers."],
    ["dedicate it to my dad", "For Dad, who taught me to read."],
    ["dedicate it to my children Ava and Leo", "For my children, Ava and Leo."],
    ["dedicate it to my children Ava and Leo", "Ava and Leo, this is for you."],
    [mom, "Love you always, Mom."],
    [mom, "Hope you enjoy it, Mom."],
    [mom, "Wish you were here, Mom."],
    [mom, "Miss you every day, Mom."],
    [mom, "Rest in peace, Mom."],
    [mom, "Until we meet again, Mom."],
    [mom, "Love always."],
    [mom, "Cheers, Mom!"],
    [mom, "For my mom, my first reader."],
    [mom, "For my mom, who never stopped believing."],
    [mom, "Mom: thank you."],
    [mom, "To my mom, my hero."],
    [mom, "This one's for you, Mom."],
    [mom, "This book is for my mom."],
    [mom, "All of this is for you, Mom."],
    [mom, "Every page is for you, Mom."],
    [mom, "Everything I write is for you, Mom."],
    [mom, "For my mom, always."],
    [mom, "Mom, I did it."],
    [mom, "Here it is, Mom."],
    [mom, "Look, Mom, I wrote a book."],
    [mom, "You were right, Mom."],
    [mom, "Remember: you are loved."],
    [mom, "Love you to the moon and back, Mom."],
    [mom, "For Mom, the best storyteller I know."],
    [mom, "Mom, thank you for every bedtime story."],
    [mom, "With gratitude to my mom."],
    [mom, "Gratitude to my mom, always."],
    [mom, "My mom, my everything."]
  ])("keeps the dedication for %j: %j", (message, text) => {
    expect(kindOf("dedication", message, text, "en", true)).toBe("change");
  });

  it.each([
    ["dedícalo a mi mamá", "Para mi mamá, con todo mi amor.", "es"],
    ["dedícalo a mi abuelo, en memoria", "En memoria de mi abuelo.", "es"],
    ["dedícalo a mi mamá, gracias por todo", "Gracias por todo, mamá.", "es"],
    ["dedica-lo à minha mãe", "Para minha mãe.", "pt"],
    ["dédie-le à ma mère", "Pour ma mère, avec amour.", "fr"],
    ["dédie-le à mon père", "À mon père.", "fr"],
    ["dédie-le à mes parents, merci pour tout", "Merci pour tout.", "fr"],
    ["dedicalo a mia madre", "Per mia madre.", "it"],
    ["widme es meiner Mutter", "Für meine Mutter.", "de"]
  ])("keeps the dedication for %j in its book's language: %j", (message, text, language) => {
    expect(kindOf("dedication", message, text, language, true)).toBe("change");
  });

  it.each([
    ["escribe mi biografía: nací en Ohio, enseño química y he escrito dos novelas", "Ana Ruiz nació en Ohio. Enseña química y ha escrito dos novelas.", "es"],
    ["escribe mi biografía: nací en Ohio, enseño química y he escrito dos novelas", "Nacida en Ohio, Ana Ruiz enseña química. Ha escrito dos novelas.", "es"],
    ["écris ma biographie : je suis née dans l'Ohio, j'enseigne la chimie", "Née dans l'Ohio, Ana Ruiz enseigne la chimie.", "fr"]
  ])("keeps the biography for %j in its book's language", (message, text, language) => {
    expect(kindOf("aboutAuthor", message, text, language, true)).toBe("change");
  });

  // Sentence starts cannot distinguish names from grammar; all novel prose
  // needs a review, including these unsupplied people in dedications.
  it.each([
    ["write my bio: I teach math", "aboutAuthor", "Sarah teaches math."],
    [mom, "dedication", "For my mom.\nMaria taught me everything."],
    ["write my bio: I teach math", "aboutAuthor", "Sarah has taught math for years."],
    ["write my bio: I teach math", "aboutAuthor", "Emily loved math from the start. She teaches it now."],
    [mom, "dedication", "For my mom. John would be proud."],
    [mom, "dedication", "For my mom. Maria always believed in me."],
    ["write my bio: I teach math", "aboutAuthor", "Elena grew up loving math. She teaches it today."],
    ["write my bio: I teach math", "aboutAuthor", "James teaches math."],
    ["write my bio: I teach math", "aboutAuthor", "Lily currently teaches math."],
    ["write my bio: I teach math", "aboutAuthor", "Sarah is a math teacher."],
    [mom, "dedication", "For my mom.\nSarah, this is for you too."],
    ["write my bio: I teach math", "aboutAuthor", "Sarah's love of math led her to teaching."]
  ] as Array<[string, "dedication" | "aboutAuthor", string]>)("refuses unsupplied sentence-initial names in prose for %j: %j", (message, field, text) => {
    expect(kindOf(field, message, text)).toBe("refused");
  });

  it.each([
    [mom, "dedication", "For my mom and Maria."],
    ["write my bio: I teach math", "aboutAuthor", "Maria Lopez teaches math."],
    ["write my bio: I live in Boston", "aboutAuthor", "She lives in Boston with Mark."],
    ["write my bio: I teach math", "aboutAuthor", "Ana Ruiz teaches math with her husband, Tom."],
    [mom, "dedication", "For my mom. Thank you, Maria."],
    [mom, "dedication", "For my mother, Elena."],
    ["write my bio: I teach math", "aboutAuthor", "Her students at Lincoln High adore her."],
    ["write my bio: I teach math", "aboutAuthor", "She teaches math. Her novel won the Pulitzer."]
  ] as Array<[string, "dedication" | "aboutAuthor", string]>)("refuses the made-up name inside a sentence for %j: %j", (message, field, text) => {
    expect(kindOf(field, message, text)).toBe("refused");
  });
});

/**
 * A fresh set written after the 2026-10-06 review's fixes and not tuned
 * against: openers of every kind, adverbs, several sentences, colon, line-break
 * and no-colon requests. Each must print exactly as composed — not refused, and
 * with no "separate change" note, because nothing else was asked.
 */
describe("legitimate bios and dedications, unseen", () => {
  const blank: BookMatterChatCurrent = { ...current, dedication: null };
  const decide = (field: "dedication" | "aboutAuthor", message: string, text: string, bookLanguage = "en", reviewed = false) =>
    (reviewed ? normalizeReviewedMatterAnswer : normalizeBookMatterChatAnswer)(answer([{ field, action: "set", text, requestedBy: message }]), { message, current: blank, bookLanguage });

  const bios: Record<string, readonly string[]> = {
    "Bio: I'm a retired civil engineer from Leeds. I garden to recharge, I taught myself to paint, and I live in Berlin now with my wife Ingrid.": [
      "Fittingly, gardening is how Ana Ruiz recharges.",
      "Retirement gave her the time to teach herself to paint.",
      "Home is Berlin, where she lives with her wife, Ingrid.",
      "Self-taught, she paints whenever the garden allows.",
      "Originally from Leeds, Ana Ruiz spent her career as a civil engineer.",
      "Engineering was her career; painting, it turns out, was her calling.",
      "Now retired, Ana Ruiz paints and gardens in Berlin.",
      "Leeds-born and Berlin-based, she is a retired civil engineer.",
      "Painting came late. Gardening came first.",
      "Before retiring, Ana Ruiz worked as a civil engineer. These days she paints, gardens and shares a home in Berlin with Ingrid."
    ],
    "write my bio: I'm Tom Becker, a pediatric nurse in Toronto. I write poetry and make quilts, and I volunteer at an animal shelter on weekends.": [
      "Tom Becker is a pediatric nurse in Toronto.",
      "By day, Tom Becker cares for children as a pediatric nurse; by night, he writes poetry.",
      "Quilting and poetry fill his evenings.",
      "Weekends find him volunteering at an animal shelter.",
      "Nursing taught him patience. Poetry taught him to listen.",
      "Unsurprisingly, the animal shelter is where he spends his weekends.",
      "When he isn't on shift, Tom Becker writes poems and makes quilts.",
      "Toronto is home.",
      "Kids, quilts and verse: that is Tom Becker's life in a sentence.",
      "Somewhere between shifts, he started writing poetry."
    ],
    "About the author:\nI grew up on a farm in Iowa, studied history, and now teach eighth grade. I run marathons and I'm writing my second mystery novel.": [
      "Raised on an Iowa farm, Ana Ruiz now teaches eighth grade.",
      "History was her first love; mysteries are her second.",
      "Marathons keep her honest.",
      "Professionally, she teaches eighth grade.",
      "Farm life in Iowa shaped her early years.",
      "Having studied history, she brings the past into her classroom.",
      "Teaching eighth graders is its own kind of marathon.",
      "Currently, she is writing her second mystery novel.",
      "Running, teaching and writing keep her busy.",
      "This is her second mystery novel.\nShe grew up on a farm in Iowa."
    ],
    "update my bio to say I'm a software developer in Lisbon, I build furniture and fix old boats, and I have two cats named Pixel and Byte": [
      "Ana Ruiz is a software developer in Lisbon.",
      "Off the clock, she builds furniture and fixes old boats.",
      "Two cats, Pixel and Byte, keep her company.",
      "Lisbon is where she writes code, builds furniture and restores old boats.",
      "Whether it's code, furniture or an old boat, Ana Ruiz likes to build things.",
      "Pixel and Byte, her two cats, supervise every project."
    ],
    "change my bio so it reads that I'm a chef in New Orleans who grew up in Manila, and I teach cooking classes for kids": [
      "Ana Ruiz is a chef in New Orleans.",
      "Raised in Manila, she now cooks in New Orleans.",
      "Cooking classes for kids are her favorite part of the week.",
      "Manila taught her to cook; New Orleans taught her to improvise.",
      "Today, Ana Ruiz teaches cooking classes for kids in New Orleans."
    ],
    "write my bio. I'm a marine biologist. I've spent ten years studying octopuses off the coast of Maine, and I write picture books for kids.": [
      "Ana Ruiz is a marine biologist.",
      "For ten years, she has studied octopuses off the coast of Maine.",
      "Octopuses are her specialty.",
      "Ocean science and picture books may seem like an odd pair, but she does both.",
      "Marine biologist by training and picture-book author by choice, Ana Ruiz studies octopuses off the coast of Maine.",
      "Studying octopuses off Maine has been her work for ten years.",
      "She writes picture books for kids."
    ],
    "write my bio, I teach yoga in Austin, write my own songs and keep bees": [
      "Ana Ruiz teaches yoga in Austin, writes her own songs and keeps bees.",
      "Yoga teacher, songwriter and beekeeper, Ana Ruiz teaches in Austin.",
      "Songwriting and beekeeping fill the hours when she isn't teaching yoga."
    ],
    "for my bio, I'm a firefighter in Denver, I coach my daughter's soccer team and fix up vintage motorcycles": [
      "Ana Ruiz is a firefighter in Denver.",
      "When she's not fighting fires in Denver, she coaches her daughter's soccer team and restores vintage motorcycles.",
      "Firefighter, soccer coach and motorcycle tinkerer, Ana Ruiz calls Denver home."
    ],
    "Author bio: Former journalist. Now I write thrillers from a cabin in Vermont with my dog, Biscuit.": [
      "A former journalist, Ana Ruiz now writes thrillers from a cabin in Vermont.",
      "Journalism taught her to chase a story; thrillers let her invent one.",
      "She shares the cabin with her dog, Biscuit.",
      "Formerly a journalist, she now writes thrillers in Vermont.",
      "Vermont, a cabin and a dog named Biscuit: that is where the thrillers get written."
    ],
    "my bio should read: I'm 34, I grew up between Lagos and London, and I work as an architect.": [
      "Ana Ruiz is a 34-year-old architect.",
      "Growing up between Lagos and London, she learned to feel at home in two cities.",
      "Architecture is her day job.",
      "Between Lagos and London, Ana Ruiz grew up; today, she works as an architect."
    ],
    // A second batch, run once with no change to the code after it was written.
    "can you redo my about the author page? I'm a veterinarian in rural Montana, I ride horses, and I volunteer with 4-H": [
      "Ana Ruiz is a veterinarian in rural Montana.",
      "Horses are part of her daily life, at work and off it.",
      "She volunteers with 4-H.",
      "Rural Montana is home to her veterinary practice."
    ],
    "please rewrite my bio — I'm a high school librarian, I collect vinyl records, and I've published three short story collections": [
      "Ana Ruiz is a high school librarian and the author of three short story collections.",
      "A lifelong collector of vinyl records, she works as a high school librarian.",
      "Vinyl, books and teenagers: her days are full.",
      "Three short story collections later, she still works in the school library."
    ],
    "Bio — I'm Kenji Watanabe, a jazz pianist from Osaka. I moved to Chicago in 2015 and I teach piano to kids on Saturdays.": [
      "Kenji Watanabe is a jazz pianist from Osaka.",
      "Since moving to Chicago in 2015, he has taught piano to kids on Saturdays.",
      "Saturdays belong to his young piano students.",
      "Osaka-born pianist Kenji Watanabe now lives in Chicago."
    ],
    "change the bio: Mother of three. Night owl. I write cozy fantasy and bake far too much sourdough.": [
      "Mother of three and a committed night owl, Ana Ruiz writes cozy fantasy.",
      "When she isn't writing, she is baking far too much sourdough.",
      "Cozy fantasy is her genre; sourdough is her weakness.",
      "Night owl, mother of three, baker of too much sourdough."
    ],
    "I'd like my author bio to mention that I served in the Navy for twelve years and now run a bookshop in Portland with my partner Sam": [
      "Ana Ruiz served in the Navy for twelve years.",
      "After twelve years in the Navy, she now runs a bookshop in Portland with her partner, Sam.",
      "Today, she and her partner, Sam, run a bookshop in Portland.",
      "Navy veteran Ana Ruiz runs a Portland bookshop with her partner."
    ]
  };
  const bioCases = Object.entries(bios).flatMap(([message, texts]) => texts.map((text) => [message, text] as const));

  it("holds at least fifty biographies", () => {
    expect(bioCases.length).toBeGreaterThanOrEqual(50);
  });

  it.each(bioCases)("prints the biography for %j: %j", (message, text) => {
    expect(decide("aboutAuthor", message, text, "en", true)).toEqual({ kind: "change", patch: { aboutAuthor: text } });
  });

  it.each([
    ["escribe mi biografía: soy ingeniera, vivo en Valencia y escribo novelas de misterio", "Profesionalmente, Ana Ruiz trabaja como ingeniera.", "es"],
    ["escribe mi biografía: soy ingeniera, vivo en Valencia y escribo novelas de misterio", "Vive en Valencia, donde escribe novelas de misterio.", "es"],
    ["escribe mi biografía: soy ingeniera, vivo en Valencia y escribo novelas de misterio", "Ingeniera de profesión y novelista por vocación, Ana Ruiz vive en Valencia.", "es"]
  ])("prints the biography for %j in its book's language: %j", (message, text, language) => {
    expect(decide("aboutAuthor", message, text, language, true)).toEqual({ kind: "change", patch: { aboutAuthor: text } });
  });

  const dedications: Record<string, readonly string[]> = {
    "Add a dedication: For my daughter Lily, who draws dragons on everything. Keep drawing, kiddo.": [
      "For my daughter Lily, who draws dragons on everything.\nKeep drawing, kiddo.",
      "For Lily, who draws dragons on everything. Keep drawing, kiddo."
    ],
    "dedicate it to my husband Marco, thank him for all the late-night coffee": [
      "For Marco, with thanks for all the late-night coffee.",
      "To my husband, Marco. Thank you for all the late-night coffee.",
      "Marco, thank you for all the late-night coffee.",
      "Thank you, Marco, for all the late-night coffee."
    ],
    "Dedication:\nTo my students at Riverside Elementary\nNever stop asking why\nMake a mess, then clean it up": [
      "To my students at Riverside Elementary.\nNever stop asking why.\nMake a mess, then clean it up.",
      "To my students at Riverside Elementary: never stop asking why."
    ],
    "dedicate the book to my grandmother Rosa, who taught me to bake bread and to never give up": [
      "For my grandmother Rosa, who taught me to bake bread and to never give up.",
      "For Grandma Rosa, who taught me to bake bread and never to give up.",
      "Rosa, you taught me to bake bread and never give up. This one is for you."
    ],
    "add a dedication for my wife: Sweetheart, this one's for you.": ["Sweetheart, this one's for you.", "For my wife.\nSweetheart, this one's for you."],
    "dedicate it to my two boys and tell them to write their own story": ["For my two boys. Write your own story.", "To my two boys: go write your own story."],
    "Dedication: For everyone who ever felt like they didn't belong. You do. Turn the page.": [
      "For everyone who ever felt like they didn't belong.\nYou do.\nTurn the page.",
      "For everyone who ever felt like they didn't belong. You do. Turn the page."
    ],
    "dedicate it to my late father, Captain James O'Neill, who loved the sea": [
      "In memory of my father, Captain James O'Neill, who loved the sea.",
      "For Dad, Captain James O'Neill, who loved the sea.",
      "To the memory of my father, who loved the sea."
    ],
    "dedicate it to my team at the Hartwell Library: you made this possible": [
      "For my team at the Hartwell Library. You made this possible.",
      "To the Hartwell Library team, who made this possible."
    ],
    "make the dedication: For Noor and Sami. Dream loudly.": ["For Noor and Sami.\nDream loudly."],
    "dedicate it to my nieces, keep asking questions and use your voice": [
      "For my nieces. Keep asking questions, and use your voice.",
      "To my nieces: keep asking questions. Use your voice."
    ],
    "Dedication: Darling Ellie,\nthe world is bigger than you think.\nGo see it.": ["Darling Ellie,\nthe world is bigger than you think.\nGo see it."],
    "Add a dedication: To Mr. Okafor, the teacher who first handed me a notebook.": ["To Mr. Okafor, the teacher who first handed me a notebook."],
    "dedicate it to my best friend Priya. Thank her for 20 years of friendship.": [
      "For Priya, my best friend, with thanks for 20 years of friendship.",
      "To Priya: 20 years of friendship, and counting."
    ],
    "Dedication: For the night-shift nurses of St. Mary's. Keep going.": ["For the night-shift nurses of St. Mary's.\nKeep going."],
    "dedicate it to my parents, Mom and Dad, for everything": ["For Mom and Dad, for everything."],
    "Dedication: Kiddo, the pictures in this book were drawn for you. Draw the stars next.": [
      "Kiddo, the pictures in this book were drawn for you. Draw the stars next."
    ],
    "Dedication:\nFor Leo —\nmake every page your own.\nKeep the light on.": ["For Leo —\nmake every page your own.\nKeep the light on."],
    // A second batch, run once with no change to the code after it was written.
    "put a dedication in for my sister Hana, something like: to Hana, my first reader and harshest critic": [
      "To Hana, my first reader and harshest critic.",
      "For my sister Hana, my first reader and harshest critic."
    ],
    "dedicate it to the kids of Room 12, who asked for more dragons": ["For the kids of Room 12, who asked for more dragons.", "To Room 12: here are your dragons."],
    "Dedication: For Grandpa Joe. Build things. Fix things. Give things away.": ["For Grandpa Joe.\nBuild things. Fix things. Give things away."],
    "dedicate it to my mom and dad. Remind them that every page is because of them.": ["For Mom and Dad.\nEvery page is because of you."],
    "the dedication should say: For Oliver, who never stopped asking “what if?”": ["For Oliver, who never stopped asking “what if?”"],
    "add a dedication to my readers, thank them for waiting so long for this one, and remove the old dedication": [
      "To my readers: thank you for waiting so long for this one."
    ],
    "dedicate it to my wife and kids, Clara, Ben and Mia": ["For my wife and kids: Clara, Ben and Mia.", "For Clara, Ben and Mia."],
    "Dedication:\nFor anyone who has ever been told they're too much.\nYou're exactly enough.\nWrite loudly.": [
      "For anyone who has ever been told they're too much.\nYou're exactly enough.\nWrite loudly."
    ],
    "dedicate it to my late dog Pepper, the best co-author a writer could have": ["For Pepper, the best co-author a writer could have."]
  };
  const dedicationCases = Object.entries(dedications).flatMap(([message, texts]) => texts.map((text) => [message, text] as const));

  it("holds at least thirty dedications", () => {
    expect(dedicationCases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(dedicationCases)("prints the dedication for %j: %j", (message, text) => {
    expect(decide("dedication", message, text, "en", true)).toEqual({ kind: "change", patch: { dedication: text } });
  });

  it.each([
    ["set the dedication to: Mamá y Papá, gracias por todo.", "Mamá y Papá, gracias por todo.", "es"],
    ["set the dedication to: Mamá y Papá, gracias por todo.", "Para Mamá y Papá. Gracias por todo.", "es"],
    ["dédicace : À ma sœur Claire, qui m'a appris à lire.", "À ma sœur Claire, qui m'a appris à lire.", "fr"],
    ["تقدیم‌نامه: تقدیم به مادرم که همیشه باورم داشت.", "تقدیم به مادرم که همیشه باورم داشت.", "fa"]
  ])("prints the dedication for %j in its book's language: %j", (message, text, language) => {
    expect(decide("dedication", message, text, language, true)).toEqual({ kind: "change", patch: { dedication: text } });
  });
});

/**
 * A third set, written after the round-6 fixes and run once without changing
 * the code after it: bios with the reader's own "I also … / We also …" and
 * refinements of the change ("Also add my dad", "Use third person"),
 * dedications whose later lines speak to the dedicatee, and bylines asked for
 * in seven languages. Each must print as composed with no "separate change"
 * note and no refusal.
 */
describe("I also, refinements, lines to the dedicatee and bylines, unseen", () => {
  const blank: BookMatterChatCurrent = { ...current, dedication: null };
  const decide = (field: "dedication" | "aboutAuthor" | "authorName", message: string, text: string, reviewed = false) =>
    (reviewed ? normalizeReviewedMatterAnswer : normalizeBookMatterChatAnswer)(answer([{ field, action: "set", text, requestedBy: message }]), { message, current: blank, bookLanguage: "en" });

  const bios: ReadonlyArray<readonly [string, string]> = [
    ["Bio: I'm a pediatric nurse in Leeds. I also write short stories about hospital life.", "Ana Ruiz is a pediatric nurse in Leeds. She also writes short stories about hospital life."],
    ["write my bio, I'm a carpenter and I also make furniture for friends", "Ana Ruiz is a carpenter who also makes furniture for friends."],
    ["About the author: I teach high school physics. I also coach the robotics team.", "Ana Ruiz teaches high school physics and also coaches the robotics team."],
    ["update my bio: I'm a librarian. I also draw comics on weekends.", "Ana Ruiz is a librarian who also draws comics on weekends."],
    ["Bio: I run a small bakery in Porto. I also translate cookbooks from Portuguese.", "Ana Ruiz runs a small bakery in Porto and also translates cookbooks from Portuguese."],
    ["my bio: We are two sisters from Cork. We also run a bookshop together.", "Ana Ruiz and her sister are from Cork. They also run a bookshop together."],
    ["Bio: I'm a retired pilot. I also keep bees and illustrate field guides.", "A retired pilot, Ana Ruiz also keeps bees and illustrates field guides."],
    ["write my author bio — I'm a midwife, and I also make pottery", "Ana Ruiz is a midwife who also makes pottery."],
    ["change my bio to: I study marine birds. I also edit a small poetry journal.", "Ana Ruiz studies marine birds. She also edits a small poetry journal."],
    ["Bio: I'm a firefighter. I also put together jigsaw puzzles with my kids.", "Ana Ruiz is a firefighter who also puts together jigsaw puzzles with her kids."],
    ["for my bio, I'm a dentist in Austin and I also fix up old guitars", "Ana Ruiz is a dentist in Austin who also fixes up old guitars."],
    ["write my bio: I'm a software tester. I also turn old maps into collages.", "Ana Ruiz is a software tester who also turns old maps into collages."],
    ["Bio: I'm a vet. I also volunteer at a horse rescue and I also write mysteries.", "Ana Ruiz is a vet who volunteers at a horse rescue and writes mysteries."],
    ["Bio: I'm a chef. I also create recipes for kids.", "Ana Ruiz is a chef who also creates recipes for kids."],
    ["Author bio: I sing in a choir. I also give piano lessons.", "Ana Ruiz sings in a choir and gives piano lessons."],
    ["Bio: I'm a nurse. I also edit a newsletter for new parents.", "Ana Ruiz is a nurse who also edits a newsletter for new parents."],
    ["Write my bio, I'm a teacher, I also print my own zines", "Ana Ruiz is a teacher who prints her own zines."],
    ["Bio: I am a teacher and I also illustrate picture books.", "Ana Ruiz is a teacher who also illustrates picture books."],
    ["Bio: I live in Halifax with my partner. We also keep two goats.", "Ana Ruiz lives in Halifax with her partner. They also keep two goats."],
    ["Bio: I'm a translator. I'll also add that I speak four languages.", "Ana Ruiz is a translator who speaks four languages."],
    ["Bio: We're a husband-and-wife team from Maine. We also make wooden toys.", "Ana Ruiz and her husband are a team from Maine who make wooden toys."],
    ["Write my bio: my wife and I run a farm. We also make cheese.", "Ana Ruiz and her wife run a farm, where they also make cheese."],
    ["Bio: I'm a coder; I also build tiny houses.", "Ana Ruiz is a coder who also builds tiny houses."],
    ["my bio should read: I'm a midwife from Accra. I also write poems in Twi.", "Ana Ruiz is a midwife from Accra who also writes poems in Twi."],
    ["Bio: I'm a teacher. I also translate children's books, and I also draw.", "Ana Ruiz is a teacher who translates children's books and draws."],
    ["Bio: I study volcanoes. I also keep a blog about them.", "Ana Ruiz studies volcanoes and keeps a blog about them."],
    ["Bio: I'm a nurse, and like most nurses I also keep odd hours.", "Ana Ruiz is a nurse who, like most nurses, keeps odd hours."],
    ["Bio: I'm a sailor. I also set crossword puzzles for the local paper.", "Ana Ruiz is a sailor who also sets crossword puzzles for the local paper."],
    ["update my bio — I'm a librarian, I also run a book club, and I also write reviews", "Ana Ruiz is a librarian who runs a book club and writes reviews."],
    ["write my bio, I'm a teacher and also write plays", "Ana Ruiz is a teacher who also writes plays."],
    ["write my bio: I'm a nurse. I also want to write a cookbook someday.", "Ana Ruiz is a nurse who hopes to write a cookbook someday."],
    ["Bio: I run marathons. Plus I also make my own running shoes.", "Ana Ruiz runs marathons and makes her own running shoes."],
    // Refinements of the change itself, which are not a request of their own.
    ["Write my bio: I'm a nurse in Ohio. Also add that I have two cats.", "Ana Ruiz is a nurse in Ohio. She has two cats."],
    ["write my bio, I'm a teacher in Leeds. Use third person.", "Ana Ruiz is a teacher in Leeds."],
    ["Bio: I'm 52 and a retired nurse. Keep my age out of it.", "Ana Ruiz is a retired nurse."],
    ["Bio: I'm a florist in Bath. Use my first name only.", "Ana is a florist in Bath."],
    ["write my bio: I fix bikes and teach kids to ride. Also mention my dog Pepper.", "Ana Ruiz fixes bikes and teaches kids to ride. She shares her days with her dog, Pepper."],
    ["Bio: I'm a nurse. Also add my dog, Biscuit.", "Ana Ruiz is a nurse who lives with her dog, Biscuit."],
    ["Bio: I teach yoga. Then add that I also run retreats.", "Ana Ruiz teaches yoga. She also runs retreats."],
    ["write my bio: I'm a potter. Please use she/her pronouns.", "Ana Ruiz is a potter. She lives for clay."],
    ["Bio: I'm a nurse in Leeds and I also make jam. Use the present tense.", "Ana Ruiz is a nurse in Leeds who also makes jam."],
    ["write my bio, I'm a park ranger, I also draw birds, and please make me sound less boring", "Ana Ruiz is a park ranger who also draws birds."],
    ["Write my bio — I'm a nurse in Ohio. Also add my husband, Tom.", "Ana Ruiz is a nurse in Ohio, where she lives with her husband, Tom."],
    ["write my bio, I'm a nurse in Leeds, then add that I've written two novels", "Ana Ruiz is a nurse in Leeds. She has written two novels."],
    ["Bio: I'm a firefighter. Also add that I coach soccer.", "Ana Ruiz is a firefighter. She also coaches soccer."],
    ["Bio: I paint murals. I also give talks at schools. Please keep it under 100 words.", "Ana Ruiz paints murals and gives talks at schools."]
  ];

  it("holds at least forty biographies", () => {
    expect(bios.length).toBeGreaterThanOrEqual(40);
  });

  it.each(bios)("prints the biography for %j: %j", (message, text) => {
    expect(decide("aboutAuthor", message, text, true)).toEqual({ kind: "change", patch: { aboutAuthor: text } });
  });

  const dedications: ReadonlyArray<readonly [string, string]> = [
    ["Dedication: For my son Theo. You also make every morning brighter.", "For my son Theo. You also make every morning brighter."],
    ["Dedication: To Grandma June, who taught me to knit. We also keep your recipes in the blue tin.", "To Grandma June, who taught me to knit. We also keep your recipes in the blue tin."],
    ["Add a dedication: For Dad. Please keep telling your terrible jokes.", "For Dad. Please keep telling your terrible jokes."],
    ["Dedication: For my students. Read widely, then write your own story.", "For my students. Read widely, then write your own story."],
    ["Dedication: For Maya. Never stop asking questions. Also, keep your sense of wonder.", "For Maya.\nNever stop asking questions. Also, keep your sense of wonder."],
    ["dedicate it to my wife Elena, and tell her: thank you for every cup of tea", "For Elena. Thank you for every cup of tea."],
    ["Dedication: For Noah. Draw your own maps.", "For Noah. Draw your own maps."],
    ["Dedication: To Mom and Dad. You both also keep my first drawings on the fridge.", "To Mom and Dad. You both also keep my first drawings on the fridge."],
    ["Dedication: For Kai and Mila, who also draw dragons on every wall.", "For Kai and Mila, who also draw dragons on every wall."],
    ["Add a dedication: For my brother. Will you finally read this one?", "For my brother. Will you finally read this one?"],
    ["Dedication: For Rosa. Please write back soon.", "For Rosa. Please write back soon."],
    ["Dedication: For my daughter. Can you keep this book safe for me?", "For my daughter. Can you keep this book safe for me?"],
    ["Dedication: For my grandchildren. Plus, keep the porch light on for me.", "For my grandchildren. Plus, keep the porch light on for me."],
    ["Dedication: For Grandpa, who fixed everything. I also fix things now, because of you.", "For Grandpa, who fixed everything. I also fix things now, because of you."],
    ["Dedication: For my kids, Ava and Leo. You two also make the best pancakes.", "For my kids, Ava and Leo. You two also make the best pancakes."],
    ["Dedication: For my readers. Keep turning pages, then write your own.", "For my readers. Keep turning pages, then write your own."],
    ["Dedication: For Sam. Please keep singing in the car.", "For Sam. Please keep singing in the car."],
    ["Dedication: For my parents, who also keep every letter I ever wrote.", "For my parents, who also keep every letter I ever wrote."],
    ["Dedication: For Ellie. Make a wish. Then make it happen.", "For Ellie. Make a wish. Then make it happen."],
    ["dedicate it to my husband, Ben — you also make me laugh every day", "For Ben. You make me laugh every day."],
    ["Dedication: For my mentor, Dr. Osei. You taught me to question everything, and then to write it down.", "For my mentor, Dr. Osei. You taught me to question everything, and then to write it down."],
    ["Add a dedication: For Aunt Bea. Please keep the garden growing.", "For Aunt Bea. Please keep the garden growing."],
    ["Dedication: For my family. You all also put up with my typing at 3 a.m.", "For my family. You all also put up with my typing at 3 a.m."],
    ["Dedication: For Iris. I also keep your drawings on my desk.", "For Iris. I also keep your drawings on my desk."],
    ["dedicate the book to my nan. Tell her I also keep her knitting needles.", "For Nan. I also keep your knitting needles."],
    ["Dedication: For Leo and Zoe. Please use your imagination every day.", "For Leo and Zoe. Please use your imagination every day."],
    ["dedicate it to my kids — they also draw on everything", "For my kids, who draw on everything."],
    ["dedicate it to Grandpa Lou, we also keep his old boat", "For Grandpa Lou. We still keep your old boat."],
    // Refinements of the change itself.
    ["dedicate it to my wife and add our dog Max too", "For my wife and our dog, Max."],
    ["dedicate it to my parents, then add my grandmother", "For my parents and my grandmother."],
    ["Dedicate it to my sister. Also add her kids.", "For my sister and her kids."],
    ["dedicate it to my late father and use his name, Arthur", "In memory of my father, Arthur."],
    ["Dedicate it to my teacher. Use her name, Mrs. Lin.", "For my teacher, Mrs. Lin."]
  ];

  it("holds at least thirty dedications", () => {
    expect(dedications.length).toBeGreaterThanOrEqual(30);
  });

  it.each(dedications)("prints the dedication for %j: %j", (message, text) => {
    expect(decide("dedication", message, text, true)).toEqual({ kind: "change", patch: { dedication: text } });
  });

  const bylines: ReadonlyArray<readonly [string, string]> = [
    ["please put Jordan Kim on the title page", "Jordan Kim"],
    ["Put J. R. Ellis on the title page instead", "J. R. Ellis"],
    ["I'd like to publish this as Mara Quinn", "Mara Quinn"],
    ["can we publish it under the name M. Quinn", "M. Quinn"],
    ["release it under my pen name, Ivy Hart", "Ivy Hart"],
    ["the book needs to be credited to Ivy Hart", "Ivy Hart"],
    ["credit me as Ivy Hart", "Ivy Hart"],
    ["The author has to be Jordan Kim", "Jordan Kim"],
    ["the writer must be my wife, Ana", "Ana"],
    ["list me as J. Kim", "J. Kim"],
    ["make it by Jordan Kim instead", "Jordan Kim"],
    ["the title page should say by Jordan Kim", "Jordan Kim"],
    ["authored by Jordan Kim, please", "Jordan Kim"],
    ["I'm publishing under the name Jordan Kim", "Jordan Kim"],
    ["it should go out under my real name, Jordan Kim", "Jordan Kim"],
    ["علی رضایی نویسنده‌ی کتاب است", "علی رضایی"],
    ["نویسنده‌ی این کتاب مریم باشه", "مریم"],
    ["کتاب رو به نام مریم کریمی منتشر کن", "مریم کریمی"],
    ["نویسنده: مریم کریمی", "مریم کریمی"],
    ["با نام مستعار مریم منتشرش کن", "مریم"],
    ["pon como autora a Lucía Gómez", "Lucía Gómez"],
    ["el autor debe ser Lucía Gómez", "Lucía Gómez"],
    ["cambia la autora por Lucía Gómez", "Lucía Gómez"],
    ["Autora: Lucía Gómez", "Lucía Gómez"],
    ["la autora es Lucía Gómez", "Lucía Gómez"],
    ["Auteur : Claire Martin", "Claire Martin"],
    ["mets Claire Martin comme auteure", "Claire Martin"],
    ["l'auteure doit être Claire Martin", "Claire Martin"],
    ["remplace l'auteur par Claire Martin", "Claire Martin"],
    ["l'auteur est Claire Martin", "Claire Martin"],
    ["Autor: Jonas Weber", "Jonas Weber"],
    ["ändere den Autor zu Jonas Weber", "Jonas Weber"],
    ["der Autor soll Jonas Weber sein", "Jonas Weber"],
    ["setze Jonas Weber als Autor", "Jonas Weber"],
    ["die Autorin ist Lena Weber", "Lena Weber"],
    ["Autore: Marco Rossi", "Marco Rossi"],
    ["metti come autore Marco Rossi", "Marco Rossi"],
    ["l'autrice è Giulia Rossi", "Giulia Rossi"],
    ["cambia l'autore in Marco Rossi", "Marco Rossi"],
    ["l'autore deve essere Marco Rossi", "Marco Rossi"],
    ["Autor: João Silva", "João Silva"],
    ["o autor deve ser João Silva", "João Silva"],
    ["mude o autor para João Silva", "João Silva"],
    ["coloque João Silva como autor", "João Silva"],
    ["a autora é Ana Souza", "Ana Souza"]
  ];

  it("holds at least forty bylines", () => {
    expect(bylines.length).toBeGreaterThanOrEqual(40);
  });

  it.each(bylines)("prints the byline asked for as %j", (message, name) => {
    expect(decide("authorName", message, name)).toEqual({ kind: "change", patch: { authorName: name } });
  });
});

/**
 * A fourth set, written after the round-8 review and before the fix it
 * measures, then run once against the code before and after it: a subject
 * that is no pronoun before "also / then / plus" and a verb, lines to the
 * dedicatee about the pictures or pages of the book in their hands, and the
 * unquoted "change <field> to …" form, which must print with no refusal and no
 * "separate change" note — and compound messages with a real second request,
 * which must still name it, and refuse a value that pastes it.
 */
describe("subjects before also, lines about the book, change-to values and compound messages, unseen", () => {
  type Field = "dedication" | "aboutAuthor" | "authorName" | "imprint" | "copyrightHolder";
  const blank: BookMatterChatCurrent = { ...current, dedication: null };
  const decide = (field: Field, message: string, text: string, reviewed = false) =>
    (reviewed ? normalizeReviewedMatterAnswer : normalizeBookMatterChatAnswer)(answer([{ field, action: "set", text, requestedBy: message }]), { message, current: blank, bookLanguage: "en" });

  const subjects: ReadonlyArray<readonly [Field, string, string]> = [
    ["aboutAuthor", "Bio: I'm a beekeeper in Devon. The two of us also keep a dozen hives on the roof.", "Ana Ruiz is a beekeeper in Devon. The two of them also keep a dozen hives on the roof."],
    ["aboutAuthor", "write my bio, I'm a retired teacher and my grandkids also draw with me every Sunday", "Ana Ruiz is a retired teacher whose grandkids also draw with her every Sunday."],
    ["aboutAuthor", "update my bio to say I run a bakery and my two sisters also make wedding cakes", "Ana Ruiz runs a bakery, and her two sisters also make wedding cakes."],
    ["aboutAuthor", "my bio should read: Ana Ruiz writes mysteries. Her readers also write to her from all over the world.", "Ana Ruiz writes mysteries. Her readers also write to her from all over the world."],
    ["aboutAuthor", "Bio: I'm a vet. My partner and our three dogs also keep me on my toes.", "Ana Ruiz is a vet. Her partner and their three dogs also keep her on her toes."],
    ["aboutAuthor", "Bio: Ana Ruiz lives in Oslo. The long winters there also give her time to write.", "Ana Ruiz lives in Oslo. The long winters there also give her time to write."],
    ["aboutAuthor", "About the author: I'm a librarian. Kids in my library also draw the maps for my books.", "Ana Ruiz is a librarian. Kids in her library also draw the maps for her books."],
    ["aboutAuthor", "Bio: I'm a potter. My students then turn their bowls into planters.", "Ana Ruiz is a potter. Her students then turn their bowls into planters."],
    ["aboutAuthor", "Bio: Ana Ruiz runs a small press. Local artists then illustrate each book by hand.", "Ana Ruiz runs a small press. Local artists then illustrate each book by hand."],
    ["aboutAuthor", "Bio: Ana Ruiz is a teacher. Her students plus their parents also write letters to her characters.", "Ana Ruiz is a teacher. Her students plus their parents also write letters to her characters."],
    ["aboutAuthor", "Bio: I grew up on a farm. Farm kids also make the best storytellers.", "Ana Ruiz grew up on a farm. Farm kids, she says, also make the best storytellers."],
    ["aboutAuthor", "Bio: I'm a pharmacist. Long night shifts also give me time to read.", "Ana Ruiz is a pharmacist. Long night shifts also give her time to read."],
    ["aboutAuthor", "About the author: Ana Ruiz is a sailor. Her two cats also put up with life on a boat.", "Ana Ruiz is a sailor. Her two cats also put up with life on a boat."],
    ["aboutAuthor", "Bio: I'm a coder in Austin. Good bugs, like good plots, also keep me up at night.", "Ana Ruiz is a coder in Austin. Good bugs, like good plots, also keep her up at night."],
    ["aboutAuthor", "write my bio: I'm a nurse, and the kids on my ward also draw me pictures", "Ana Ruiz is a nurse, and the kids on her ward also draw her pictures."],
    ["dedication", "Dedication: For Mom and Dad. Your old stories also keep me writing.", "For Mom and Dad. Your old stories also keep me writing."],
    ["dedication", "Dedication: For my students. Brave questions also make brave people.", "For my students. Brave questions also make brave people."],
    ["dedication", "Dedication: For Lily. Small hands also make big things.", "For Lily. Small hands also make big things."],
    ["dedication", "add a dedication: For my sisters. Late-night talks also make the best memories.", "For my sisters. Late-night talks also make the best memories."],
    ["dedication", "Dedication: For Grandpa Joe. His tools, his patience, his jokes also keep me going.", "For Grandpa Joe. His tools, his patience, his jokes also keep me going."],
    ["dedication", "dedicate it to my parents — their bedtime stories also make me who I am", "For my parents. Their bedtime stories also make me who I am."],
    ["dedication", "Dedication: To everyone in Room 12. Kind words also make a classroom.", "To everyone in Room 12. Kind words also make a classroom."],
    ["dedication", "Dedication: For my team. First we dream; the hard days then make the dream real.", "For my team. First we dream; the hard days then make the dream real."],
    ["aboutAuthor", "Bio: I write by day. At night my two kids then edit every page with red crayons.", "Ana Ruiz writes by day. At night her two kids then edit every page with red crayons."],
    ["aboutAuthor", "Bio: I live in Lisbon. Friends from the choir also give me ideas for every story.", "Ana Ruiz lives in Lisbon. Friends from her choir also give her ideas for every story."],
    ["aboutAuthor", "write my author bio: Ana Ruiz is a midwife. Her patients also give her the stories she writes.", "Ana Ruiz is a midwife. Her patients also give her the stories she writes."],
    ["aboutAuthor", "Bio: I'm a ranger in Montana. The bears and the snow also keep me humble.", "Ana Ruiz is a ranger in Montana. The bears and the snow also keep her humble."],
    ["aboutAuthor", "Bio: Ana Ruiz teaches music. Her students also write songs with her every spring.", "Ana Ruiz teaches music. Her students also write songs with her every spring."],
    ["aboutAuthor", "update my bio: I'm a baker. My twin daughters also make the frosting.", "Ana Ruiz is a baker. Her twin daughters also make the frosting."],
    ["aboutAuthor", "Bio: Ana Ruiz and her wife Kim also keep a bookshop in Bath.", "Ana Ruiz and her wife Kim also keep a bookshop in Bath."],
    ["aboutAuthor", "my bio should say I'm a carpenter and my apprentices also fix old chairs", "Ana Ruiz is a carpenter whose apprentices also fix old chairs."],
    ["dedication", "dedicate it to my readers, people like you also keep stories alive", "For my readers. People like you also keep stories alive."],
    ["dedication", "dedicate it to the volunteers at the shelter; volunteers also make a town a home", "For the volunteers at the shelter. Volunteers also make a town a home."],
    ["dedication", "Dedication: For my kids. Muddy boots and big questions also make a childhood.", "For my kids. Muddy boots and big questions also make a childhood."],
    ["dedication", "Dedication: For Dad. Tired hands also make warm bread.", "For Dad. Tired hands also make warm bread."],
    ["aboutAuthor", "Bio: I'm a doctor. Most of my patients also give me book ideas, with permission.", "Ana Ruiz is a doctor. Most of her patients also give her book ideas, with permission."],
    ["aboutAuthor", "Bio: Ana Ruiz is a mother of three. All three kids also write stories of their own.", "Ana Ruiz is a mother of three. All three kids also write stories of their own."],
    ["aboutAuthor", "Bio: I'm a teacher in Ghana. Twenty years of classrooms also give me my best stories.", "Ana Ruiz is a teacher in Ghana. Twenty years of classrooms also give her the best stories."],
    ["dedication", "Dedication: For Noor. Rainy days also make good reading days.", "For Noor. Rainy days also make good reading days."],
    ["dedication", "Dedication: For my mother, Rosa. Her recipes and her songs also keep this family together.", "For my mother, Rosa. Her recipes and her songs also keep this family together."],
    ["aboutAuthor", "write my bio, my wife and two sons also write, so books are everywhere at home", "Ana Ruiz's wife and two sons also write, so there are books everywhere in their home."],
    ["aboutAuthor", "Bio: I'm a pilot. Long flights then give me hours to write.", "Ana Ruiz is a pilot. Long flights then give her hours to write."],
    ["dedication", "add a dedication: To my sister Mia. Big sisters plus little sisters also make a team.", "To my sister Mia. Big sisters plus little sisters also make a team."],
    ["aboutAuthor", "Bio: I'm a florist in Bath. Some customers then turn their bouquets into stories for me.", "Ana Ruiz is a florist in Bath. Some customers then turn their bouquets into stories for her."],
    ["aboutAuthor", "Bio: Ana Ruiz is a teacher, and children everywhere also give her hope.", "Ana Ruiz is a teacher, and children everywhere also give her hope."],
    ["dedication", "Dedication: For my parents. You two, more than anyone, also keep me honest.", "For my parents. You two, more than anyone, also keep me honest."],
    ["dedication", "dedicate it to my parents, who, like all good teachers, also make me think", "For my parents, who, like all good teachers, also make me think."]
  ];

  it("holds at least forty subjects before also, then or plus", () => {
    expect(subjects.length).toBeGreaterThanOrEqual(40);
  });

  it.each(subjects)("prints the %s for %j: %j", (field, message, text) => {
    expect(decide(field, message, text, true)).toEqual({ kind: "change", patch: { [field]: text } });
  });

  const aboutTheBook: ReadonlyArray<readonly [string, string]> = [
    ["Dedication: For Leo. Make the pictures in this book your own.", "For Leo. Make the pictures in this book your own."],
    ["Dedication: For my granddaughter. Color the pictures in this book any way you like.", "For my granddaughter. Color the pictures in this book any way you like."],
    ["Add a dedication: For Sam. Draw your own dragons on the pictures in this book.", "For Sam. Draw your own dragons on the pictures in this book."],
    ["Dedication: For Ava. Use the pictures in this book to tell your own stories.", "For Ava. Use the pictures in this book to tell your own stories."],
    ["Dedication: For my nephew. Turn to page 12 whenever you need a laugh.", "For my nephew. Turn to page 12 whenever you need a laugh."],
    ["Dedication: For my class. Write your names on the cover of this book.", "For my class. Write your names on the cover of this book."],
    ["dedicate it to my son, and tell him to keep this book's pictures in his heart", "For my son. Keep this book's pictures in your heart."],
    ["Dedication: For Rosa. Keep the drawings in this book safe for me.", "For Rosa. Keep the drawings in this book safe for me."],
    ["Dedication: For my daughter. Give the pictures in this book your favorite colors.", "For my daughter. Give the pictures in this book your favorite colors."],
    ["Dedication: For the kids of Room 4. Put this book's pictures on your fridge.", "For the kids of Room 4. Put this book's pictures on your fridge."],
    ["Dedication: For Theo. Make the cover of this book your treasure map.", "For Theo. Make the cover of this book your treasure map."],
    ["Dedication:\nFor my grandson\nKeep the pictures in this book and remember me", "For my grandson\nKeep the pictures in this book and remember me"],
    ["Dedication: For Zoe. Add your own pictures to the pages of this book.", "For Zoe. Add your own pictures to the pages of this book."],
    ["dedicate it to my kids, use the pictures in this book to dream big", "For my kids. Use the pictures in this book to dream big."],
    ["Dedication: For Eli. Draw on the pictures in this book if you want to.", "For Eli. Draw on the pictures in this book if you want to."],
    ["Dedication: For Nana. Turn this book's pages slowly, the way you always read to me.", "For Nana. Turn this book's pages slowly, the way you always read to me."],
    ["Dedication: For Max. Make the pictures in this book come alive.", "For Max. Make the pictures in this book come alive."],
    ["Dedication: For my students. Keep the illustrations in this book as a reminder of our year.", "For my students. Keep the illustrations in this book as a reminder of our year."],
    ["Dedication: For Hana. Write your own ending on the last page of this book.", "For Hana. Write your own ending on the last page of this book."],
    ["Dedication: For June. Cut out the pictures in this book and hang them up.", "For June. Cut out the pictures in this book and hang them up."],
    ["Dedication: For my reader. Put the pictures in this book under your pillow.", "For my reader. Put the pictures in this book under your pillow."],
    ["dedicate it to Ellie and say: keep the pictures in this book forever", "For Ellie. Keep the pictures in this book forever."],
    ["Dedication: For Oscar. Give the drawings in this book to your little sister someday.", "For Oscar. Give the drawings in this book to your little sister someday."],
    ["Dedication: For the twins. Make the pictures in this book bigger with your imagination.", "For the twins. Make the pictures in this book bigger with your imagination."],
    ["Dedication: For Ruby. Draw the pictures in this book again in your own way.", "For Ruby. Draw the pictures in this book again in your own way."]
  ];

  it("holds at least twenty lines to the dedicatee about the book", () => {
    expect(aboutTheBook.length).toBeGreaterThanOrEqual(20);
  });

  it.each(aboutTheBook)("prints the dedication for %j: %j", (message, text) => {
    expect(decide("dedication", message, text, true)).toEqual({ kind: "change", patch: { dedication: text } });
  });

  const changedTo: ReadonlyArray<readonly [Field, string, string]> = [
    ["dedication", "change the dedication to For my kids. Please keep dreaming big.", "For my kids. Please keep dreaming big."],
    ["dedication", "Change the dedication to For Grandma. Please write back soon.", "For Grandma. Please write back soon."],
    ["aboutAuthor", "Change my bio to I'm a nurse in Ohio. I also make quilts.", "Ana Ruiz is a nurse in Ohio. She also makes quilts."],
    ["aboutAuthor", "update my bio to I teach math. My students also make me laugh every day.", "Ana Ruiz teaches math. Her students also make her laugh every day."],
    ["dedication", "set the dedication to To my wife. Will you keep dancing with me?", "To my wife. Will you keep dancing with me?"],
    ["dedication", "change the dedication to For Dad. Then fix the boat, like you promised.", "For Dad. Then fix the boat, like you promised."],
    ["dedication", "make the dedication to my mom. Please keep the porch light on.", "For my mom. Please keep the porch light on."],
    ["aboutAuthor", "change the about the author to Ana Ruiz is a chef. Her kids also make the desserts.", "Ana Ruiz is a chef. Her kids also make the desserts."],
    ["dedication", "change the dedication to For my team. Keep building, keep shipping.", "For my team. Keep building, keep shipping."],
    ["dedication", "Change the dedication to For Maya. Also, keep your sense of humor.", "For Maya. Also, keep your sense of humor."],
    ["dedication", "change the dedication to For Ben. Please use your words.", "For Ben. Please use your words."],
    ["dedication", "change the dedication to For my parents. Thank you for everything. Please keep the stories coming.", "For my parents. Thank you for everything. Please keep the stories coming."],
    ["aboutAuthor", "update my bio to I'm a pilot. Please don't mention my age.", "Ana Ruiz is a pilot."],
    ["dedication", "change the dedication to To my students at Hill School. Please write to me sometime.", "To my students at Hill School. Please write to me sometime."],
    ["aboutAuthor", "Change my bio to Ana Ruiz grows tomatoes. Her neighbors then make sauce from them.", "Ana Ruiz grows tomatoes. Her neighbors then make sauce from them."],
    ["dedication", "set the dedication to For Lena. Please keep drawing on the walls.", "For Lena. Please keep drawing on the walls."],
    ["dedication", "change the dedication to For my brother. Can you keep a secret?", "For my brother. Can you keep a secret?"],
    ["aboutAuthor", "change my author bio to I'm a nurse. Please also add that I keep bees.", "Ana Ruiz is a nurse who keeps bees."],
    ["dedication", "change the dedication to For Pip. Please give this book to someone who needs it one day.", "For Pip. Please give this book to someone who needs it one day."],
    ["dedication", "update the dedication to For my wife. Keep the coffee warm for me.", "For my wife. Keep the coffee warm for me."],
    ["aboutAuthor", "change my bio to I'm a florist. Flowers also make me happy.", "Ana Ruiz is a florist. Flowers also make her happy."],
    ["dedication", "change the dedication to For Nora. Please turn the page.", "For Nora. Please turn the page."],
    ["dedication", "the dedication should read For my kids. Please keep dreaming.", "For my kids. Please keep dreaming."],
    ["aboutAuthor", "my bio should say I'm a nurse. Plus I also make jam.", "Ana Ruiz is a nurse. She also makes jam."]
  ];

  it("holds at least twenty change-to values", () => {
    expect(changedTo.length).toBeGreaterThanOrEqual(20);
  });

  it.each(changedTo)("prints the %s for %j: %j", (field, message, text) => {
    expect(decide(field, message, text, true)).toEqual({ kind: "change", patch: { [field]: text } });
  });

  /** The field, the message, the value printed right, and — where one is plausible — the value that pastes the second request. */
  const compound: ReadonlyArray<readonly [Field, string, string, string?]> = [
    ["dedication", "change the dedication to my mom and fix the typos", "For my mom"],
    ["dedication", "change the dedication to my mom then fix the typos", "For my mom"],
    ["dedication", "change the dedication to my mom. Also redo the cover.", "For my mom", "For my mom. Also redo the cover."],
    ["imprint", "change the publisher to Lantern Press then make page 2 shorter", "Lantern Press", "Lantern Press then make page 2 shorter"],
    ["imprint", "Change the publisher to Lantern and make chapter 2 shorter", "Lantern", "Lantern and make chapter 2 shorter"],
    ["authorName", "Author: Sam Lee also redo the cover", "Sam Lee", "Sam Lee also redo the cover"],
    ["dedication", "Dedication: For my mom. You can also redo the cover.", "For my mom.", "For my mom. You can also redo the cover."],
    ["dedication", "dedicate it to my dad then make the villain scarier", "For my dad", "For my dad then make the villain scarier"],
    ["aboutAuthor", "Bio: I'm a nurse in Leeds. Also make the hero braver.", "Ana Ruiz is a nurse in Leeds.", "I'm a nurse in Leeds. Also make the hero braver."],
    ["dedication", "add a dedication to my kids and make the ending happier", "For my kids"],
    ["dedication", "Dedication: For Grandma.\nAlso change the title to Moonlight", "For Grandma", "For Grandma.\nAlso change the title to Moonlight"],
    ["aboutAuthor", "write my bio, I'm a chef in Lyon, and redo the cover", "Ana Ruiz is a chef in Lyon."],
    ["dedication", "dedicate it to my sister, also could you shorten chapter 4", "For my sister"],
    ["authorName", "make Sam Lee the author and redraw the pictures in the book", "Sam Lee"],
    ["dedication", "Dedication: For my team. Plus make page 5 shorter.", "For my team.", "For my team. Plus make page 5 shorter."],
    ["copyrightHolder", "change the copyright holder to Ruiz Media, and fix the typos on page 3", "Ruiz Media"],
    ["dedication", "dedicate it to my wife then regenerate the cover", "For my wife", "For my wife then regenerate the cover"],
    ["aboutAuthor", "update my bio to say I'm a teacher and also make chapter 1 longer", "Ana Ruiz is a teacher."],
    ["dedication", "Dedication: For you. You could also make the cover blue.", "For you.", "For you. You could also make the cover blue."],
    ["imprint", "Publisher: Lantern Press then fix the typos", "Lantern Press", "Lantern Press then fix the typos"],
    ["dedication", "dedicate it to my parents and change the title to Home", "For my parents", "For my parents and change the title to Home"],
    ["dedication", "Change the dedication to For Mom. Also make the dragon green on page 3.", "For Mom.", "For Mom. Also make the dragon green on page 3."],
    ["aboutAuthor", "Bio: Ana Ruiz is a nurse. Her kids also draw. Also redo the cover.", "Ana Ruiz is a nurse. Her kids also draw.", "Ana Ruiz is a nurse. Her kids also draw. Also redo the cover."],
    ["dedication", "change the dedication to my kids, and can you make the font bigger", "For my kids"],
    ["aboutAuthor", "Bio: I'm a nurse in Leeds also redo the cover", "Ana Ruiz is a nurse in Leeds."]
  ];

  it("holds at least twenty compound messages", () => {
    expect(compound.length).toBeGreaterThanOrEqual(20);
  });

  const printedRight: ReadonlyArray<readonly [Field, string, string]> = compound.map(([field, message, text]) => [field, message, text] as const);
  it.each(printedRight)("names what else the %s message %j asked, beside %j", (field, message, text) => {
    expect(decide(field, message, text, true)).toEqual({ kind: "change", patch: { [field]: text }, unhandledUnquoted: true });
  });

  const pasted: ReadonlyArray<readonly [Field, string, string]> = compound.flatMap(([field, message, , value]) =>
    value === undefined ? [] : [[field, message, value] as const]
  );
  it.each(pasted)("refuses the %s for %j printed with its second request: %j", (field, message, value) => {
    expect(decide(field, message, value)).toMatchObject({ kind: "refused", problem: { kind: "runs_on", field } });
  });
});
