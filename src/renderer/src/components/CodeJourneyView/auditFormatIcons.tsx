/*
-T ---
*/

import React from 'react'
import { Code, Sparkles, FileText, Package } from 'lucide-react'

export const FORMAT_ICONS: Record<1 | 2 | 3 | 4, React.ReactNode> = {
  1: <Code size={17} strokeWidth={2} />,
  2: <Sparkles size={17} strokeWidth={2} />,
  3: <FileText size={17} strokeWidth={2} />,
  4: <Package size={17} strokeWidth={2} />
}