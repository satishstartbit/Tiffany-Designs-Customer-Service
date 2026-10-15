import { Armchair, Archive, BedDouble, Footprints, Library, Lamp, Shirt, Sofa, Tv } from 'lucide-react';

// An icon for each shop category, used where a product has no photo.
const CATEGORY_ICONS = {
  'Shoe Storage': Footprints,
  Bookshelves: Library,
  'TV Cabinets': Tv,
  Wardrobes: Shirt,
  'Study Tables': Lamp,
  Chairs: Armchair,
  Beds: BedDouble,
  'Storage Cabinets': Archive,
};

export function CategoryIcon({ category, ...props }) {
  const Icon = CATEGORY_ICONS[category] || Sofa;
  return <Icon aria-hidden="true" {...props} />;
}
