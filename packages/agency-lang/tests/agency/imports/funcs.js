export function bestSong(artist) {
  switch (artist) {
    case "Radiohead":
      return "Street Spirit";
    case "The Beatles":
      return "Hey Jude";
    case "Beyoncé":
      return "Halo";
    default:
      return "Unknown artist";
  }
}
